import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '../../../utils/api';
import { escapeRegExp } from '../utils/chatFormatting';
import { replaceCompletionToken } from '../utils/completionBoundary';
import type { Project } from '../../../types/app';

interface ProjectFileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
}

export interface MentionableFile {
  name: string;
  path: string;
  relativePath?: string;
}

interface UseFileMentionsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

const flattenFileTree = (files: ProjectFileNode[], basePath = ''): MentionableFile[] => {
  let flattened: MentionableFile[] = [];

  files.forEach((file) => {
    const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'directory' && file.children) {
      flattened = flattened.concat(flattenFileTree(file.children, fullPath));
      return;
    }

    if (file.type === 'file') {
      flattened.push({
        name: file.name,
        path: fullPath,
        relativePath: file.path,
      });
    }
  });

  return flattened;
};

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchProjectFiles = async () => {
      // File list is keyed by DB projectId now; the backend resolves it to
      // the project's path before reading.
      const projectId = selectedProject?.projectId;
      setFileList([]);
      setFilteredFiles([]);
      if (!projectId) {
        return;
      }


      try {
        const response = await api.getFiles(projectId, { signal: abortController.signal });
        if (!response.ok) {
          return;
        }

        const files = (await response.json()) as ProjectFileNode[];
        setFileList(flattenFileTree(files));
      } catch (error) {
        // Ignore aborts from rapid project switches; we only care about the latest request.
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        console.error('Error fetching files:', error);
      }
    };

    fetchProjectFiles();
    return () => {
      abortController.abort();
    };
  }, [selectedProject?.projectId]);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    /**
     * `@` 之后出现任意空白(含换行)就收起下拉,不只认半角空格:
     * 只认半角空格的话,换了行下拉还开着,盖住上方消息,还把 ↑/↓ 吞掉
     * (方向键既移不动光标,也触发不了历史回填)。
     */
    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    if (/\s/.test(textAfterAt)) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    /**
     * `@` 前面必须是行首或空白,否则 `zhang@example.com` 这种邮箱地址
     * 一打出来就弹文件下拉。
     */
    const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : '';
    if (charBeforeAt && !/\s/.test(charBeforeAt)) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
          file.path.toLowerCase().includes(textAfterAt.toLowerCase()),
      )
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [input, cursorPosition, fileList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-primary/[0.08] box-decoration-clone px-0.5 text-transparent"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      /**
       * 被替换的只是「@ 到光标」这一段,后面的正文一个字都不许动。
       *
       * 不能按 `indexOf(' ')` 找结尾:换行不是空格,中文正文里也没有半角空格,
       * 回头去改一个提及(光标停在 `@Rea` 后面、下面还有几行正文)时会把后面全吃掉。
       * 判据在 `completionBoundary`,与斜杠命令共用一份,有测试钉住。
       */
      const { text: newInput, caret: newCursorPosition } = replaceCompletionToken(
        input,
        atSymbolPosition,
        file.path,
        cursorPosition,
      );

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, cursorPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        // 没高亮任何一项时不抢回车。
        //
        // 这个下拉的开启条件极宽:光标前有 `@` 且其后无空白就开,空查询也开
        // (空串对所有文件都成立)。回车若无条件退而取首项,「帮我回复 @」+ 回车
        // 就不是发送,而是把文件列表第一项的路径插进输入框。
        //
        // Tab 不在此列:补全键补成第一个匹配项是它该有的行为。
        if (event.key === 'Enter' && selectedFileIndex < 0) {
          return false;
        }
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
