/** Wire contract for the raw-sandbox routes (`routes/sandboxes.ts`). These shapes mirror
 *  `@alineo-labs/sandbox`'s own option types one-to-one. */
import { z } from "zod";

const NetworkRule = z.object({
  action: z.enum(["allow", "deny"]),
  target: z.string().min(1),
});

const NetworkPolicy = z.object({
  defaultAction: z.enum(["allow", "deny"]).optional(),
  egress: z.array(NetworkRule),
});

export const CreateSandboxBody = z.object({
  name: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  resources: z.object({
    cpu: z.string().min(1),
    memory: z.string().min(1),
    gpu: z.string().optional(),
  }),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  networkPolicy: NetworkPolicy.optional(),
  credentialProxy: z.boolean().optional(),
});
export type CreateSandboxBody = z.infer<typeof CreateSandboxBody>;

export const CheckpointBody = z.object({ name: z.string().min(1).optional() }).optional();

export const ForkBody = z.object({ tag: z.string().min(1).optional() }).optional();

const CredentialInjection = z.union([
  z.object({ type: z.literal("header"), name: z.string().min(1) }),
  z.object({
    type: z.literal("substitution"),
    placeholder: z.string().min(1),
    in: z.array(z.enum(["path", "query", "header", "body"])),
  }),
]);

export const SetCredentialBody = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  binding: z.object({
    host: z.string().min(1),
    pathPrefix: z.string().optional(),
    injection: CredentialInjection,
  }),
});

export const EgressPatchBody = z.object({ rules: z.array(NetworkRule) });
export const EgressDeleteBody = z.object({ targets: z.array(z.string().min(1)) });

export const ListSandboxesQuery = z.object({
  status: z.enum(["running", "completed"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});
