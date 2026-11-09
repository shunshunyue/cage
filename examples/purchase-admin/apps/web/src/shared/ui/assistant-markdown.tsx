/**
 * 助理输出的 Markdown 展示边界，支持 GFM 表格及链接，并跳过原始 HTML。
 * 图片转换为纯文字说明，避免模型文本直接触发图片加载；业务状态仍由真实查询呈现。
 */
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 模型文字是不可信内容：支持 Markdown/GFM，不执行 HTML，也不自动加载模型给出的远端图片。 */
/**
 * 将 children 中的模型文本渲染为受限 Markdown；外链使用独立窗口和 noopener 等关系属性。
 * 只负责显示，不执行代码块、不把文本转成业务命令，也不对内容的事实准确性背书。
 */
export function AssistantMarkdown({ children }: { children: string }) {
  return <div className="assistant-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="assistant-image-label">[图片：{alt || '未提供说明'}]</span>,
    table: ({ children }) => <div className="assistant-table"><table>{children}</table></div>,
  }}>{children}</Markdown></div>;
}
