import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

describe("MarkdownEditor", () => {
  it("切换笔记或拉取远端内容时不会误触发本地编辑", () => {
    const onChange = vi.fn();
    const view = render(<MarkdownEditor value="第一篇内容" onChange={onChange} />);

    view.rerender(<MarkdownEditor value="远端同步后的第二篇内容" onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
    expect(view.container).toHaveTextContent("远端同步后的第二篇内容");
  });
});
