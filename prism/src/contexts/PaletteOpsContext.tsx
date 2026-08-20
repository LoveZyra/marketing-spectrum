import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

export type PaletteOps = {
  openFile: (path: string) => void;
  // Opens a file in the editor side panel without changing the active tab
  // (used by in-chat file links so they behave like the inline edit view).
  openFileInEditor: (path: string) => void;
  openSettings: (tab?: string) => void;
  refreshProjects: () => Promise<void> | void;
  // 切到 notebook 标签页并把该文件在 JupyterLab 里打开(AppContent 注册)。
  openInJupyter: (path: string) => void;
  // 打开命令面板 —— 面板自己监听 ⌘K,这个入口给鼠标用户(侧栏搜索框右侧的键帽)。
  openPalette: () => void;
};

type Registry = MutableRefObject<Partial<PaletteOps>>;

const PaletteOpsContext = createContext<Registry | null>(null);

const defaultOps: PaletteOps = {
  openFile: () => undefined,
  openFileInEditor: () => undefined,
  openSettings: () => undefined,
  refreshProjects: () => undefined,
  openInJupyter: () => undefined,
  openPalette: () => undefined,
};

export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Partial<PaletteOps>>({});
  return <PaletteOpsContext.Provider value={ref}>{children}</PaletteOpsContext.Provider>;
}

export function usePaletteOps(): PaletteOps {
  const ref = useContext(PaletteOpsContext);
  return useMemo<PaletteOps>(
    () => ({
      openFile: (path) => (ref?.current.openFile ?? defaultOps.openFile)(path),
      openFileInEditor: (path) =>
        (ref?.current.openFileInEditor ?? defaultOps.openFileInEditor)(path),
      openSettings: (tab) => (ref?.current.openSettings ?? defaultOps.openSettings)(tab),
      refreshProjects: () => (ref?.current.refreshProjects ?? defaultOps.refreshProjects)(),
      openInJupyter: (path) => (ref?.current.openInJupyter ?? defaultOps.openInJupyter)(path),
      openPalette: () => (ref?.current.openPalette ?? defaultOps.openPalette)(),
    }),
    [ref],
  );
}

export function usePaletteOpsRegister(partial: Partial<PaletteOps>) {
  const ref = useContext(PaletteOpsContext);
  const { openFile, openFileInEditor, openSettings, refreshProjects, openInJupyter, openPalette } = partial;

  useEffect(() => {
    if (!ref) return undefined;
    const prev = { ...ref.current };
    if (openFile) ref.current.openFile = openFile;
    if (openFileInEditor) ref.current.openFileInEditor = openFileInEditor;
    if (openSettings) ref.current.openSettings = openSettings;
    if (refreshProjects) ref.current.refreshProjects = refreshProjects;
    if (openInJupyter) ref.current.openInJupyter = openInJupyter;
    if (openPalette) ref.current.openPalette = openPalette;
    return () => {
      if (openFile && ref.current.openFile === openFile) ref.current.openFile = prev.openFile;
      if (openFileInEditor && ref.current.openFileInEditor === openFileInEditor) ref.current.openFileInEditor = prev.openFileInEditor;
      if (openSettings && ref.current.openSettings === openSettings) ref.current.openSettings = prev.openSettings;
      if (refreshProjects && ref.current.refreshProjects === refreshProjects) ref.current.refreshProjects = prev.refreshProjects;
      if (openInJupyter && ref.current.openInJupyter === openInJupyter) ref.current.openInJupyter = prev.openInJupyter;
      if (openPalette && ref.current.openPalette === openPalette) ref.current.openPalette = prev.openPalette;
    };
  }, [ref, openFile, openFileInEditor, openSettings, refreshProjects, openInJupyter, openPalette]);
}
