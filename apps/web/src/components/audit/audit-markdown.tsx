import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN_COMPONENTS: Components = {
  table: ({ children }) => (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

export default function AuditMarkdown({ value }: { value: string }) {
  return (
    <div className="markdown-report">
      <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]}>
        {value}
      </Markdown>
    </div>
  );
}
