import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent text is untrusted. Only these link schemes become links. */
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Render an agent's reply as markdown. Raw HTML in the text is shown as text, never run. Images are not loaded
 * (an agent could point one at any address), so they show as their alt text. Links open in a new tab.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }: { href?: string; children?: ReactNode }) {
            if (!href || !SAFE_LINK.test(href)) return <span>{children}</span>;
            return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
          },
          img({ alt }: { alt?: string }) {
            return <span className="md-img">{alt ? `[image: ${alt}]` : "[image]"}</span>;
          },
          // A wide table scrolls inside the message instead of stretching the panel.
          table({ children }: { children?: ReactNode }) {
            return <div className="md-table"><table>{children}</table></div>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
