import type { ComponentType } from "react";
import type { FileDescriptor } from "./files";

export interface ViewerProps {
  file: FileDescriptor;
  tabId: string;
  onDirtyChange: (dirty: boolean) => void;
  onStatusChange: (status: string) => void;
}

export interface FileHandler {
  id: string;
  displayName: string;
  supportedExtensions: string[];
  supportedMimeTypes: string[];
  canOpen(file: FileDescriptor): Promise<boolean>;
  load(): Promise<{ default: ComponentType<ViewerProps> }>;
  dispose?(): Promise<void>;
}
