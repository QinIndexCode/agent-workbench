import { FileIcon, defaultStyles, type FileIconProps } from "react-file-icon";
import type { TaskAttachment } from "@scc/shared";

const kindFallbackExtension: Record<TaskAttachment["kind"], string> = {
  binary: "bin",
  code: "js",
  data: "csv",
  image: "png",
  markdown: "md",
  office: "docx",
  pdf: "pdf",
  text: "txt"
};

const kindFallbackType: Record<TaskAttachment["kind"], NonNullable<FileIconProps["type"]>> = {
  binary: "binary",
  code: "code",
  data: "spreadsheet",
  image: "image",
  markdown: "document",
  office: "document",
  pdf: "acrobat",
  text: "document"
};

const extensionStyles = defaultStyles as Record<string, Partial<FileIconProps> | undefined>;

export function FileTypeIcon({
  fileName,
  kind
}: {
  fileName: string;
  kind: TaskAttachment["kind"];
}) {
  const extension = extensionFromName(fileName) || kindFallbackExtension[kind];
  const style = extensionStyles[extension] ?? extensionStyles[kindFallbackExtension[kind]] ?? {};
  return (
    <span aria-hidden="true" className="fileTypeIcon">
      <FileIcon
        extension={extension}
        labelUppercase
        radius={5}
        type={kindFallbackType[kind]}
        {...style}
      />
    </span>
  );
}

function extensionFromName(fileName: string): string {
  const clean = fileName.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  if (index <= 0 || index === clean.length - 1) return "";
  return clean.slice(index + 1).replace(/[^a-z0-9]/g, "").slice(0, 10);
}
