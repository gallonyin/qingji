import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

const paperTheme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "#292724", fontSize: "16px" },
  ".cm-scroller": { fontFamily: "'Iowan Old Style', 'Noto Serif SC', serif", lineHeight: "1.9", overflow: "auto" },
  ".cm-content": { padding: "34px 9% 120px", caretColor: "#a33a2b" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(163,58,43,.035)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(163,58,43,.16)" },
  "&.cm-focused": { outline: "none" }
});

export function MarkdownEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const changeRef = useRef(onChange);
  const applyingExternalValue = useRef(false);
  changeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          paperTheme,
          keymap.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternalValue.current) {
              changeRef.current(update.state.doc.toString());
            }
          })
        ]
      })
    });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    applyingExternalValue.current = true;
    try {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
    } finally {
      applyingExternalValue.current = false;
    }
  }, [value]);

  return <div className="cm-host" ref={host} />;
}
