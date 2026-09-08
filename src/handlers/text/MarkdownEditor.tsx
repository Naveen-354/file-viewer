import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

interface MarkdownEditorProps {
  content: string;
  editable: boolean;
  onChange: (markdown: string) => void;
}

export default function MarkdownEditor({ content, editable, onChange }: MarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const [, setRevision] = useState(0);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer" } } }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
    editable,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": "Markdown rich-text editor", role: "textbox" } },
    onUpdate: ({ editor: current }) => { onChangeRef.current(current.getMarkdown()); setRevision((value) => value + 1); },
    onSelectionUpdate: () => setRevision((value) => value + 1),
  });

  useEffect(() => { editor?.setEditable(editable); }, [editable, editor]);

  if (!editor) return <div className="empty-state">Loading rich-text editor…</div>;

  const setLink = () => {
    const previous = String(editor.getAttributes("link").href ?? "");
    const href = window.prompt("Link URL", previous);
    if (href === null) return;
    if (!href.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  return (
    <div className="markdown-editor">
      <div className="viewer-toolbar markdown-toolbar" aria-label="Rich-text formatting">
        <FormatButton label="Bold" active={editor.isActive("bold")} disabled={!editable} run={() => editor.chain().focus().toggleBold().run()} />
        <FormatButton label="Italic" active={editor.isActive("italic")} disabled={!editable} run={() => editor.chain().focus().toggleItalic().run()} />
        <FormatButton label="Underline" active={editor.isActive("underline")} disabled={!editable} run={() => editor.chain().focus().toggleUnderline().run()} />
        <FormatButton label="Strike" active={editor.isActive("strike")} disabled={!editable} run={() => editor.chain().focus().toggleStrike().run()} />
        <FormatButton label="Heading 1" active={editor.isActive("heading", { level: 1 })} disabled={!editable} run={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <FormatButton label="Heading 2" active={editor.isActive("heading", { level: 2 })} disabled={!editable} run={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <FormatButton label="Bulleted list" active={editor.isActive("bulletList")} disabled={!editable} run={() => editor.chain().focus().toggleBulletList().run()} />
        <FormatButton label="Numbered list" active={editor.isActive("orderedList")} disabled={!editable} run={() => editor.chain().focus().toggleOrderedList().run()} />
        <FormatButton label="Quote" active={editor.isActive("blockquote")} disabled={!editable} run={() => editor.chain().focus().toggleBlockquote().run()} />
        <FormatButton label="Code" active={editor.isActive("code")} disabled={!editable} run={() => editor.chain().focus().toggleCode().run()} />
        <FormatButton label="Link" active={editor.isActive("link")} disabled={!editable} run={setLink} />
        <span className="spacer" />
        <button type="button" disabled={!editable || !editor.can().chain().focus().undo().run()} onClick={() => editor.chain().focus().undo().run()}>Undo</button>
        <button type="button" disabled={!editable || !editor.can().chain().focus().redo().run()} onClick={() => editor.chain().focus().redo().run()}>Redo</button>
      </div>
      <div className="markdown-scroll"><EditorContent editor={editor} className="markdown-page" /></div>
    </div>
  );
}

function FormatButton({ label, active, disabled, run }: { label: string; active: boolean; disabled: boolean; run: () => void }) {
  return <button type="button" className={active ? "selected" : ""} aria-pressed={active} disabled={disabled} onClick={run}>{label}</button>;
}
