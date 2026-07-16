"use client";

import * as React from "react";
import { FileUpload } from "@/components/ui/file-upload";

export interface FileDropzoneProps {
  accept?: string;
  multiple?: boolean;
  title?: string;
  description?: string;
  className?: string;
  onFilesAccepted?: (files: File[]) => void;
}

export function FileDropzone({
  accept,
  multiple = true,
  title,
  description,
  className,
  onFilesAccepted,
}: FileDropzoneProps): React.ReactElement {
  return (
    <FileUpload
      accept={accept}
      multiple={multiple}
      title={title}
      description={description}
      className={className}
      onFilesAccepted={onFilesAccepted}
    />
  );
}
