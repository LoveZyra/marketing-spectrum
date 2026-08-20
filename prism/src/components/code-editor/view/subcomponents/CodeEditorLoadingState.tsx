import { Shimmer } from '../../../../shared/view/ui';
import { getEditorLoadingStyles } from '../../utils/editorStyles';

type CodeEditorLoadingStateProps = {
  isDarkMode: boolean;
  isSidebar: boolean;
  loadingText: string;
};

export default function CodeEditorLoadingState({
  isDarkMode,
  isSidebar,
  loadingText,
}: CodeEditorLoadingStateProps) {
  return (
    <>
      <style>{getEditorLoadingStyles(isDarkMode)}</style>
      {isSidebar ? (
        <div className="flex h-full w-full items-center justify-center bg-background">
          <Shimmer className="text-sm">{loadingText}</Shimmer>
        </div>
      ) : (
        <div className="fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-[rgba(16,16,16,0.72)]">
          <div className="code-editor-loading flex h-full w-full items-center justify-center p-8 md:h-auto md:w-auto md:rounded-lg">
            <Shimmer className="text-sm">{loadingText}</Shimmer>
          </div>
        </div>
      )}
    </>
  );
}
