import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { safeLocalStorage } from '../utils/chatStorage';
import { replaceCompletionToken } from '../utils/completionBoundary';
import type { LLMProvider, Project } from '../../../types/app';

const COMMAND_QUERY_DEBOUNCE_MS = 150;

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  provider: LLMProvider;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onExecuteCommand: (command: SlashCommand, rawInput?: string) => void | Promise<void>;
  /** Live session id — enables dynamic CLI slash-command discovery. */
  sessionId?: string | null;
}

type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

type ProviderSkillsResponse = {
  success?: boolean;
  data?: {
    skills?: ProviderSkill[];
  };
};

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

const isSkillCommand = (command: SlashCommand) =>
  command.type === 'skill' || command.metadata?.type === 'skill';

const isBuiltinCommand = (command: SlashCommand) =>
  command.type === 'builtin' || command.namespace === 'builtin' || command.metadata?.type === 'builtin';

/**
 * 这条命令该由谁来跑?
 *
 * `/api/commands/execute` 只认两种:**六个内置命令**(服务端有 handler),
 * 以及**带 path 的自定义命令**(服务端去 `.claude/commands/` 读文件)。
 * 除此之外的一律得**打进输入框、当成提示词发给 CLI 去解释**。
 *
 * 之前只挑出了技能,于是从 `/api/claude/slash-commands` 拿回来的那批 **CLI 自带
 * 命令**(`/compact`、`/clear`、`/init`…)也被送去 execute 端点 ——
 * 它们既没有 handler 也没有 path,一律撞在
 * 「Command path is required for custom commands」上。
 */
export const isPromptCommand = (command: SlashCommand) => {
  if (isSkillCommand(command)) return true;
  if (command.type === 'cli' || command.namespace === 'cli') return true;
  // 自定义命令没有 path,服务端读不到文件 —— 交给模型总比报错强。
  return !isBuiltinCommand(command) && !command.path;
};

const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});

const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(commandPrefix),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(normalizedQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  return commands.filter((command) =>
    command.description?.toLowerCase().includes(normalizedQuery),
  );
};

export function useSlashCommands({
  selectedProject,
  provider,
  input,
  setInput,
  textareaRef,
  onExecuteCommand,
  sessionId,
}: UseSlashCommandsOptions) {
  /**
   * dv:静态列表与 CLI 动态列表**分开存**,读的时候再合。
   *
   * 原来两者共用一个 state:静态那条链(内置 + 项目自定义 + 技能,两次串行
   * 往返)用**整体替换**写入,而动态 CLI 那条(`/compact`、`/clear`、`/init`…)
   * 只在 `[sessionId, provider]` 变化时跑一次、用追加写入。于是两种情况都会
   * 把 CLI 命令抹掉且再也回不来:① 首屏动态先到、静态后到;② 会话运行中
   * 侧栏刷新让 `selectedProject` 换了对象身份,静态 effect 重跑而 sessionId
   * 没变、动态 effect 不重跑。用户敲 `/compact` 还能靠"无 path 交给模型"那条
   * 兜底,但菜单里看不见、补全不了。
   */
  const [staticCommands, setStaticCommands] = useState<SlashCommand[]>([]);
  const [cliCommands, setCliCommands] = useState<SlashCommand[]>([]);
  const slashCommands = useMemo(() => {
    if (cliCommands.length === 0) return staticCommands;
    const known = new Set(staticCommands.map((command) => command.name.toLowerCase()));
    const additions = cliCommands.filter((command) => !known.has(command.name.toLowerCase()));
    return additions.length > 0 ? [...staticCommands, ...additions] : staticCommands;
  }, [staticCommands, cliCommands]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  /**
   * fj:鼠标悬停的那一项。**只用于视觉高亮**,不参与回车行为判定
   * (见 handleCommandSelect 的说明)。
   */
  const [hoveredCommandIndex, setHoveredCommandIndex] = useState(-1);
  const [slashPosition, setSlashPosition] = useState(-1);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  useEffect(() => {
    let cancelled = false;

    const fetchCommands = async () => {
      if (!selectedProject) {
        setStaticCommands([]);
        setFilteredCommands([]);
        return;
      }

      try {
        const workspacePath = selectedProject.fullPath || selectedProject.path || '';
        const response = await authenticatedFetch('/api/commands/list', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectPath: workspacePath || selectedProject.path,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch commands');
        }

        const data = await response.json();
        const skillsParams = new URLSearchParams();
        if (workspacePath) {
          skillsParams.set('workspacePath', workspacePath);
        }

        const skillsResponse = await authenticatedFetch(
          `/api/providers/${encodeURIComponent(provider)}/skills${skillsParams.toString() ? `?${skillsParams.toString()}` : ''}`,
        );
        const skillsData = skillsResponse.ok
          ? ((await skillsResponse.json()) as ProviderSkillsResponse)
          : null;
        const skillCommands = dedupeProviderSkills(skillsData?.data?.skills || [])
          .map(mapSkillToSlashCommand);
        const allCommands: SlashCommand[] = [
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'built-in',
          })),
          ...skillCommands,
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
        ];

        const parsedHistory = readCommandHistory(selectedProject.projectId);
        const sortedCommands = [...allCommands].sort((commandA, commandB) => {
          const commandAUsage = parsedHistory[commandA.name] || 0;
          const commandBUsage = parsedHistory[commandB.name] || 0;
          return commandBUsage - commandAUsage;
        });

        if (!cancelled) {
          setStaticCommands(sortedCommands);
        }
      } catch (error) {
        console.error('Error fetching slash commands:', error);
        if (!cancelled) {
          setStaticCommands([]);
        }
      }
    };

    fetchCommands();
    return () => {
      cancelled = true;
    };
  }, [selectedProject, provider]);

  // Prism: once a session is live, merge in the CLI's real slash commands
  // (from the runtime's supportedCommands()) that the static list may miss.
  useEffect(() => {
    if (!sessionId || provider !== 'claude') return;
    let cancelled = false;

    const fetchDynamic = async () => {
      try {
        const response = await authenticatedFetch(
          `/api/claude/slash-commands?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data?.available || !Array.isArray(data.commands)) return;

        // dv:存进自己那份 state —— 去重放到合并那一步,静态列表怎么重写都不会
        // 再把它们抹掉。
        setCliCommands(
          (data.commands as Array<{ name?: string; description?: string; argumentHint?: string }>)
            .filter((entry) => Boolean(entry?.name))
            .map((entry) => ({
              name: entry.name as string,
              description: entry.description || '',
              namespace: 'cli',
              type: 'cli',
              metadata: { type: 'cli', argumentHint: entry.argumentHint || '' },
            })),
        );
      } catch {
        // best-effort enrichment; static list already covers common commands
      }
    };

    fetchDynamic();
    return () => {
      cancelled = true;
    };
  }, [sessionId, provider]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  useEffect(() => {
    setFilteredCommands(filterSlashCommands(slashCommands, commandQuery));
  }, [commandQuery, slashCommands]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.projectId);

    return slashCommands
      .map((command) => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter((command) => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.projectId);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.projectId, parsedHistory);
    },
    [selectedProject],
  );

  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      const currentTextarea = textareaRef.current;
      const insertionStart = slashPosition >= 0
        ? slashPosition
        : currentTextarea?.selectionStart ?? input.length;
      const textBeforeCommand = input.slice(0, insertionStart);
      /**
       * fj:命令 token 的结尾同样是**第一个空白字符**(与 `@` 提及同源的 bug)。
       *
       * 原来是 `indexOf(' ')` 之后 `slice(spaceIndex).trimStart()` —— 空格**之前**
       * 的所有内容(含换行和那一行的正文)被整段丢掉:`/comp\nabc def` 补全成
       * `/compact def`,`\nabc` 没了。没有空格时才走 `selectionEnd` 兜底、内容才
       * 保得住,所以这个 bug 是"有空格才炸",更难被发现。判据与 `@` 提及共用。
       */
      const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';
      const { text: newInput } = replaceCompletionToken(
        input,
        insertionStart,
        `${separator}${command.name}`,
        currentTextarea?.selectionEnd ?? undefined,
      );

      setInput(newInput);
      resetCommandMenuState();

      window.requestAnimationFrame(() => {
        currentTextarea?.focus();
        const nextCursorPosition = `${textBeforeCommand}${separator}${command.name} `.length;
        currentTextarea?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
    },
    [input, resetCommandMenuState, setInput, slashPosition, textareaRef],
  );

  const executeNonSkillCommand = useCallback(
    (command: SlashCommand) => {
      const executionResult = onExecuteCommand(command);
      if (isPromiseLike(executionResult)) {
        executionResult.then(
          () => {
            resetCommandMenuState();
          },
          () => {
            resetCommandMenuState();
            // Keep behavior silent; execution errors are handled by caller.
          },
        );
      } else {
        resetCommandMenuState();
      }
    },
    [onExecuteCommand, resetCommandMenuState],
  );

  /**
   * 键盘选中一条命令。
   *
   * `mode` 区分 **Tab 与 Enter**:
   * - `complete`(Tab):**只把命令补进输入框**,任何类型都一样。以前 Tab 走的是
   *   和 Enter 完全相同的分支 —— 于是只有技能"像补全",其余的一按 Tab 就直接执行了,
   *   看起来就是"除了 skill 都不支持 tab 补全"。
   * - `submit`(Enter):技能与 CLI 命令进输入框,内置/自定义命令交服务端执行。
   */
  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand, mode: 'complete' | 'submit') => {
      if (mode === 'complete' || isPromptCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [executeNonSkillCommand, insertCommandIntoInput],
  );

  /**
   * fj:输入框里当前那个斜杠 token(去掉前导 `/`)—— Tab 补全据此实时算匹配,
   * 不吃 150ms 去抖之后才更新的 `commandQuery`。
   */
  const currentSlashToken = useCallback((): string => {
    if (slashPosition < 0) return '';
    const rest = input.slice(slashPosition + 1);
    const whitespace = rest.match(/\s/);
    return whitespace?.index !== undefined ? rest.slice(0, whitespace.index) : rest;
  }, [input, slashPosition]);

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        /**
         * fj:悬停只做**视觉高亮**,不写决定回车行为的那个 index。
         *
         * 菜单是 440px 宽的 portal,锚在输入框上方最多 360px 高 —— 正好盖在最后
         * 几条消息上,是鼠标很自然的停放位置。原来 `onMouseEnter` 直接写
         * `selectedCommandIndex`,而"没高亮就不抢回车"的判据是 `< 0`,
         * **悬停也算高亮**:用户输入 `/deploy 到测试环境` 这类以斜杠开头的正常
         * 消息,鼠标恰好在那片区域,按回车就变成"插入鼠标底下那条命令"。
         */
        setHoveredCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      if (isPromptCommand(command)) {
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [selectedProject, trackCommandUsage, insertCommandIntoInput, executeNonSkillCommand],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery('');
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (newValue: string, cursorPos: number) => {
      if (!newValue.trim()) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = newValue.slice(0, cursorPos);
      const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
      const inCodeBlock = backticksBefore % 2 === 1;

      if (inCodeBlock) {
        resetCommandMenuState();
        return;
      }

      // Match / at start of input OR after whitespace, capturing the /word up to cursor.
      const slashPattern = /(?:^|\s)(\/\S*)$/;
      const match = textBeforeCursor.match(slashPattern);

      if (!match) {
        resetCommandMenuState();
        return;
      }

      // Compute actual position of / in the full input string.
      const slashPos = match.index! + (match[0].length - match[1].length);
      const query = match[1].slice(1); // strip leading /

      setSlashPosition(slashPos);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!filteredCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resetCommandMenuState();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) =>
          previousIndex < filteredCommands.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHoveredCommandIndex(-1);
        setSelectedCommandIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredCommands.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        const mode = event.key === 'Tab' ? 'complete' : 'submit';
        // 没高亮任何一项时**不抢回车**(注意 preventDefault 也要一起让开,
        // 否则回车既不选中也不发送)。
        //
        // 原来这里无条件退而取首项:配上 150ms 的查询去抖,快打 `/clear` 立刻回车,
        // 插进去的是 `commandQuery` 还停在 `cle`/`c`/`''` 时那份列表的首项 ——
        // 用户敲的和插进去的完全无关。让回车按它本来的意思走(发送);
        // 想选命令的人本来就会先按方向键。
        //
        // Tab 不在此列 —— 它是补全键,"补成第一个匹配项"正是它该有的行为。
        // fj:只看**键盘**选中的那个 index —— 悬停不参与(见 handleCommandSelect)。
        if (event.key === 'Enter' && selectedCommandIndex < 0) {
          return false;
        }
        event.preventDefault();
        /**
         * fj:Tab 补全用**当前输入实时算**的匹配,不用 `filteredCommands`。
         *
         * `filteredCommands` 由 `commandQuery` 派生,而 `commandQuery` 晚 150ms
         * (去抖)—— 连打 `/compact` 后 150ms 内按 Tab(快打字者的键间隔常在
         * 100ms 上下),列表可能还停在上一次查询上,补进去的是一个和用户所敲
         * 毫无关系的命令。第 573 行那条修复只把 **Enter** 排除在"退而取首项"
         * 之外,注释也写明"Tab 不在此列",但没考虑列表本身是旧的。
         */
        const liveTarget = event.key === 'Tab' && selectedCommandIndex < 0
          ? filterSlashCommands(slashCommands, currentSlashToken())[0]
          : null;
        const target = liveTarget
          ?? (selectedCommandIndex >= 0
            ? filteredCommands[selectedCommandIndex]
            : filteredCommands[0]);
        if (target) {
          selectCommandFromKeyboard(target, mode);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        resetCommandMenuState();
        return true;
      }

      return false;
    },
    [
      showCommandMenu, filteredCommands, resetCommandMenuState, selectCommandFromKeyboard,
      selectedCommandIndex, slashCommands, currentSlashToken,
    ],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    hoveredCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  };
}
