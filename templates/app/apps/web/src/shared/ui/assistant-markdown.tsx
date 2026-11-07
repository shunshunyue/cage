import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 模型文字是不可信内容：支持 Markdown/GFM，不执行 HTML，也不自动加载模型给出的远端图片。 */
export function AssistantMarkdown({ children }: { children: string }) {
  return <div className="assistant-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="assistant-image-label">[图片：{alt || '未提供说明'}]</span>,
    table: ({ children }) => <div className="assistant-table"><table>{children}</table></div>,
  }}>{children}</Markdown></div>;
}
