/**
 * Where a checkpoint tarball (or any backup file) lives when it is not on the host's disk.
 *
 * durability-roadmap M4, 4.1. A checkpoint on the host disk survives a lost container. It does not
 * survive a lost disk. `BlobStore` is the small surface the checkpoint and restore code needs from
 * object storage, so the S3 client stays behind one interface: another store, or a fake in a test,
 * is one class.
 *
 * Keys are relative to the store. A store may sit under a prefix in its bucket, and `refOf()` /
 * `keyOf()` convert between a key and the full reference written to the ledger.
 */

export interface BlobInfo {
  /** Relative to the store, the same key `put()` took. */
  key: string;
  /** Unix ms. */
  lastModified: number;
}

export interface BlobStore {
  /** `string` is the path of a local file, streamed from disk. Bytes are sent as they are. */
  put(key: string, body: string | Uint8Array): Promise<void>;
  /** Throws if the key does not exist. */
  get(key: string): Promise<Uint8Array>;
  /** Not an error when the key is already gone. */
  delete(key: string): Promise<void>;
  /** Every blob whose key starts with `prefix`, in no particular order. */
  list(prefix: string): Promise<BlobInfo[]>;
  /** The reference recorded in the ledger for `key`. Stable across processes and hosts. */
  refOf(key: string): string;
  /** The inverse of `refOf()`, or `undefined` when this store did not produce `ref`. */
  keyOf(ref: string): string | undefined;
}

/** Joins path parts with one `/` between them, ignoring empty parts and stray slashes. */
function joinKey(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
}

/**
 * The slice of `Bun.S3Client` that `S3BlobStore` calls. A test passes a fake instead of a bucket.
 */
export interface S3ClientLike {
  file(key: string): {
    write(data: Blob | Uint8Array | string): Promise<number>;
    bytes(): Promise<Uint8Array>;
  };
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; continuationToken?: string }): Promise<{
    contents?: Array<{ key: string; lastModified?: string }>;
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
}

export interface S3BlobStoreOptions {
  bucket: string;
  /** Everything this store writes goes under it. No leading or trailing slash needed. */
  prefix?: string;
  /** For R2, MinIO and other S3-compatible services. Leave out for AWS. */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** A fake in tests. Production code leaves it out and gets a `Bun.S3Client`. */
  client?: S3ClientLike;
}

/** S3, R2, MinIO: anything `Bun.S3Client` talks to. Runs under Bun only. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3ClientLike;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BlobStoreOptions) {
    this.bucket = opts.bucket;
    this.prefix = joinKey(opts.prefix ?? "");
    this.client =
      opts.client ??
      new Bun.S3Client({
        bucket: opts.bucket,
        endpoint: opts.endpoint,
        region: opts.region,
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      });
  }

  private full(key: string): string {
    return joinKey(this.prefix, key);
  }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    // A path is streamed from disk by Bun, so a large tarball is not copied into memory again.
    await this.client.file(this.full(key)).write(typeof body === "string" ? Bun.file(body) : body);
  }

  async get(key: string): Promise<Uint8Array> {
    return this.client.file(this.full(key)).bytes();
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(this.full(key));
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    const root = this.prefix === "" ? "" : `${this.prefix}/`;
    let token: string | undefined;
    do {
      const page = await this.client.list({
        prefix: this.full(prefix),
        continuationToken: token,
      });
      for (const item of page.contents ?? []) {
        out.push({
          key: item.key.startsWith(root) ? item.key.slice(root.length) : item.key,
          lastModified: item.lastModified ? Date.parse(item.lastModified) : 0,
        });
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return out;
  }

  refOf(key: string): string {
    return `s3://${this.bucket}/${this.full(key)}`;
  }

  keyOf(ref: string): string | undefined {
    const head = `s3://${this.bucket}/${this.prefix === "" ? "" : `${this.prefix}/`}`;
    return ref.startsWith(head) ? ref.slice(head.length) : undefined;
  }
}

/**
 * Keeps blobs in a Map. The store the unit tests use, and a reference for what a `BlobStore` must
 * do. `now` lets a test age a blob without waiting.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(key: string, body: string | Uint8Array): Promise<void> {
    const bytes = typeof body === "string" ? await Bun.file(body).bytes() : body.slice();
    this.blobs.set(key, { bytes, at: this.now() });
  }

  get(key: string): Promise<Uint8Array> {
    const hit = this.blobs.get(key);
    if (!hit) return Promise.reject(new Error(`no such blob: ${key}`));
    return Promise.resolve(hit.bytes.slice());
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<BlobInfo[]> {
    return Promise.resolve(
      [...this.blobs]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, v]) => ({ key, lastModified: v.at })),
    );
  }

  refOf(key: string): string {
    return `mem://${key}`;
  }

  keyOf(ref: string): string | undefined {
    return ref.startsWith("mem://") ? ref.slice("mem://".length) : undefined;
  }

  /** Test seam: every key, so a test can assert what was written or deleted. */
  keys(): string[] {
    return [...this.blobs.keys()].sort();
  }
}
