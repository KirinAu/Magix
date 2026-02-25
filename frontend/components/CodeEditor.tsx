"use client";

import Editor from "@monaco-editor/react";
import { useRef } from "react";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export default function CodeEditor({ value, onChange }: CodeEditorProps) {
  const editorRef = useRef<any>(null);

  return (
    <div className="h-full w-full rounded-2xl overflow-hidden border border-gray-100">
      <Editor
        height="100%"
        defaultLanguage="javascript"
        value={value}
        theme="vs-dark"
        onChange={(v: string | undefined) => onChange(v ?? "")}
        onMount={(editor: any) => { editorRef.current = editor; }}
        options={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: "on",
          wordWrap: "on",
          tabSize: 2,
          automaticLayout: true,
          padding: { top: 16, bottom: 16 },
        }}
      />
    </div>
  );
}
