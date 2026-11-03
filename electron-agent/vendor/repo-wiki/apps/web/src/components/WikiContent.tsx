/** Legacy view compatibility. The workspace uses the same safe Markdown pipeline. */
import { Markdown } from "../workspace/Markdown";
export default function WikiContent({
  content,
}: {
  content: string;
  title: string;
}) {
  return <Markdown value={content} onSource={() => {}} onPage={() => {}} />;
}
