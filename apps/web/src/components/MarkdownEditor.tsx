import {useLocale, t} from '../lib/i18n';
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const phraseTranslations: Record<string, readonly [string, string]> = {
  Find: ['查找', '検索'], Replace: ['替换', '置換'], next: ['下一个', '次へ'], previous: ['上一个', '前へ'], all: ['全部', 'すべて'],
  'match case': ['区分大小写', '大文字・小文字を区別'], regexp: ['正则表达式', '正規表現'], 'by word': ['全字匹配', '単語単位'],
  replace: ['替换', '置換'], 'replace all': ['全部替换', 'すべて置換'], close: ['关闭', '閉じる'],
  'Go to line': ['跳转到行', '行へ移動'], go: ['跳转', '移動'], 'current match': ['当前匹配', '現在の一致'], 'on line': ['所在行', '行'],
  'replaced match on line $': ['已替换第$行的匹配', '$行の一致を置換しました'], 'replaced $ matches': ['已替换$个匹配', '$件を置換しました'],
  'Selection deleted': ['已删除选中内容', '選択範囲を削除しました'], 'Control character': ['控制字符', '制御文字'],
  Completions: ['补全', '補完候補'], Diagnostics: ['诊断', '診断'], 'No diagnostics': ['无诊断', '診断なし']
};
function editorPhrases(locale: string): Record<string, string> {
  return locale === 'en' ? {} : Object.fromEntries(Object.entries(phraseTranslations).map(([key, values]) => [key, values[locale === 'ja' ? 1 : 0]]));
}

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
  const locale = useLocale();
  const language = useRef(new Compartment());
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
          language.current.of([EditorState.phrases.of(editorPhrases(locale)), EditorView.contentAttributes.of({"aria-label": t("Markdown 编辑器")})]),
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
    view.current?.dispatch({effects: language.current.reconfigure([EditorState.phrases.of(editorPhrases(locale)), EditorView.contentAttributes.of({"aria-label": t("Markdown 编辑器")})])});
  }, [locale]);

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
