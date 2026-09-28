// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { NotesInput, isNotesField } from "./NotesInput";

afterEach(cleanup);

function Harness({ onCommit }: { onCommit: (v: string) => void }) {
  const [v, setV] = useState("");
  return <NotesInput value={v} onChange={setV} onCommit={onCommit} />;
}

const setup = () => {
  const onCommit = vi.fn();
  const { container } = render(<Harness onCommit={onCommit} />);
  const ta = container.querySelector("textarea")!;
  return { ta, onCommit };
};

describe("NotesInput", () => {
  it("Alt+Enter inserts a new line at the caret and does not save", async () => {
    const { ta, onCommit } = setup();
    fireEvent.change(ta, { target: { value: "Line one" } });
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    const ev = fireEvent.keyDown(ta, { key: "Enter", altKey: true });
    expect(ev).toBe(false); // default prevented
    expect(ta.value).toBe("Line one\n");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Shift+Enter is left to the browser (native new line) and does not save", () => {
    const { ta, onCommit } = setup();
    fireEvent.change(ta, { target: { value: "Line one" } });
    const ev = fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(ev).toBe(true); // not prevented -> textarea inserts the newline
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("plain Enter saves with the full multi-line text", () => {
    const { ta, onCommit } = setup();
    fireEvent.change(ta, { target: { value: "Line one\nLine two" } });
    const ev = fireEvent.keyDown(ta, { key: "Enter" });
    expect(ev).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("Line one\nLine two");
  });

  it("shows the keyboard hint", () => {
    const { container } = render(<Harness onCommit={() => {}} />);
    expect(container.textContent).toContain("Shift+Enter or Alt+Enter for a new line");
  });
});

describe("isNotesField", () => {
  it("matches notes fields only", () => {
    expect(isNotesField({ key: "other_notes", label: "Additional Notes", type: "text" })).toBe(true);
    expect(isNotesField({ key: "pension_additional_notes", label: "X", type: "text" })).toBe(true);
    expect(isNotesField({ key: "named_beneficiaries", label: "Named beneficiaries", type: "text" })).toBe(false);
    expect(isNotesField({ key: "other_notes", label: "Additional Notes", type: "select" })).toBe(false);
  });
});

function PlainHarness({ onCommit }: { onCommit: (v: string) => void }) {
  const [v, setV] = useState("");
  return <NotesInput value={v} onChange={setV} onCommit={onCommit} allowNewlines={false} />;
}

describe("NotesInput — ordinary text fields (allowNewlines=false)", () => {
  const long = "Annual income for life (an annuity) paid for 5 years if death occurs within 5 years of retirement; no payment to dependants after 5 years.";
  const setupPlain = () => {
    const onCommit = vi.fn();
    const { container } = render(<PlainHarness onCommit={onCommit} />);
    return { ta: container.querySelector("textarea")!, container, onCommit };
  };

  it("is a wrapping textarea, so long answers stay visible", () => {
    const { ta } = setupPlain();
    fireEvent.change(ta, { target: { value: long } });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe(long);
  });

  it("Enter, Shift+Enter and Alt+Enter all save instead of adding a line", () => {
    for (const mods of [{}, { shiftKey: true }, { altKey: true }]) {
      cleanup();
      const { ta, onCommit } = setupPlain();
      fireEvent.change(ta, { target: { value: long } });
      expect(fireEvent.keyDown(ta, { key: "Enter", ...mods })).toBe(false);
      expect(onCommit).toHaveBeenCalledWith(long);
      expect(ta.value).not.toContain("\n");
    }
  });

  it("turns pasted line breaks into spaces", () => {
    const { ta } = setupPlain();
    fireEvent.change(ta, { target: { value: "one" + "\r" + "\n" + "two" + "\n" + "three" } });
    expect(ta.value).toBe("one two three");
  });

  it("does not show the new-line hint", () => {
    const { container } = setupPlain();
    expect(container.textContent).not.toContain("for a new line");
  });
});
