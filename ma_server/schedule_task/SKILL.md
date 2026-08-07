---
name: schedule-task
description: 配置定时任务(crontab 或 session cron)。当用户说"配定时任务/定时跑/定期执行/每周每天定时/crontab/cron"时触发。
---

# 定时任务管理

为用户配置定时任务，支持两种模式：系统级 crontab 和 session 级 CronCreate。

> **核心难点不是写 cron 表达式，是让 `claude -p` 在 cron 的空环境里跑得起来。**
> cron 不是登录 shell：不加载 `.bashrc` / `.profile` / Jupyter 启动脚本，只给
> `HOME`、`SHELL`、`PATH=/usr/bin:/bin`。于是**两层东西同时消失**：
>
> 1. **claude 自己** —— PATH 里没有它、`HOME` 指错就读不到 `~/.claude`
> 2. **大数据栈** —— `JAVA_HOME` / `HADOOP_HOME` / `HADOOP_CONF_DIR` / `SPARK_HOME` /
>    `HIVE_CONF_DIR` / `PYSPARK_PYTHON` / `PYTHONPATH` 全没了，表现是
>    `core-site.xml not found`、`import pyspark 失败`、`Spark worker 找不到 Python`
>
> 第 2 层最容易被忽略，因为链路是
> `cron → run.sh → claude → Bash 工具 → python3 → SparkSubmit`，
> 环境靠一路继承传下去，**断在最上游、报错在最下游** —— 看着像 Spark 挂了，其实是 cron 的锅。
>
> 铁律：**配任务之前先跑 `_shared/preflight.sh`**，它用 `env -i` 模拟 cron 的空环境
> 逐条验，通过了再配。

## 部署

```bash
tar xzf schedule-task-skill.tar.gz -C /home/jovyan/
bash /home/jovyan/schedule_task/install.sh
```

`install.sh` 幂等，可反复跑；已有的 `<任务名>/` 目录、日志、crontab 条目一律不动。
它会补执行位、把 `SKILL.md` 装进 `~/.claude/skills/schedule-task/`（不装 claude 发现不了
这个 skill）、装 cron 并恢复 crontab 条目、跑一次体检探出 claude 绝对路径。

装完还差两步，脚本代劳不了：**在能跑通的交互终端里**跑一次 `capture_env.sh` 取环境快照，
然后 `preflight.sh --deep` 把 ✗ 清零。见下面步骤 0。

## 工作流

### 步骤 0（必做）：环境快照 + 体检

**0a. 只要任务会碰 Spark / Hive / HDFS，先在一个能跑通的交互式 Jupyter 终端里做快照：**

```bash
bash /home/jovyan/schedule_task/_shared/capture_env.sh
```

它把当前 session 的环境（`JAVA_HOME`、`HADOOP_CONF_DIR`、`SPARK_HOME`、`HIVE_CONF_DIR`、
`PYSPARK_PYTHON`、`PYTHONPATH`、`PATH` …）快照成 `_shared/runtime_env.sh`，cron 侧由
`claude_env.sh` 原样加载。**用快照而不是手写 export 清单**：手写会漏（py4j 的 zip 带
版本号、`PYSPARK_DRIVER_PYTHON` 最容易漏），而且会烂（运维换个 Spark 版本，清单里的路径
悄悄失效，**不报错**，只是 Spark 找不到 JDK）。镜像升级后重跑一次即可。

需要微调（比如 `PYSPARK_PYTHON` 要换成绝对路径、cron 想用更小的 Spark 资源），
`cp _shared/bigdata_env.sh.example _shared/bigdata_env.sh` 再改——它在快照之后加载，覆盖快照。

**0b. 体检：**

```bash
bash /home/jovyan/schedule_task/_shared/preflight.sh          # 常规
bash /home/jovyan/schedule_task/_shared/preflight.sh --deep   # 加验环境是否穿透到 Bash 工具
```

✗ 项必须清零。它会顺手把 `claude` 的绝对路径探出来写进 `_shared/claude_bin.env`，
之后所有任务都用绝对路径调用，不再靠 PATH 碰运气；第 5 节在 `env -i` 空环境里逐条验
`java` / `hdfs` / `spark-submit` / `import pyspark` / `core-site.xml` / `hive-site.xml`；
`--deep` 再让 claude 自己用 Bash 工具把这些变量打出来，确认传到了孙进程。

### 步骤 1：理解任务 + 确定类型

理解用户要定时执行什么、什么时间。然后用 **AskUserQuestion** 问用户选哪种：

- **系统 cron（crontab + 脚本）**：不依赖 Claude session 存活，无人值守到点自动触发。
  pod 重启后 cron 进程和 crontab 条目都会丢，`setup_cron.sh` 能一键恢复（条目从
  `_shared/crontab.txt` 灌回）。适合长期定时。
- **Session cron（CronCreate）**：挂在当前 session 上，不用写 .sh。需要 session 一直
  存活（建议 tmux）。recurring 任务 7 天自动过期。适合一次性任务。

### 步骤 2a：系统 cron

1. **任务名**：小写+下划线，如 `daily_report`、`weekly_cleanup`
2. **建目录**：`mkdir -p /home/jovyan/schedule_task/<任务名>/{logs,tasks,work}`
3. **提示词落盘**：写 `tasks/prompt.md`（**不要内联进 .sh**——提示词里出现一个
   单引号就把脚本写坏了；落盘还能原样复盘、改词不动脚本）。内容要求：
   - 开头加：`⚠️ 强制从头重新执行，不要检查/复用已有产物，不要跳过任何步骤，必须实际跑一遍全部命令`
   - 加一段无人值守声明：`这是无人值守的自动化调用，没有人会回答你的问题。拿不准的地方按下面口径自己定，把不确定的写进产物的 notes，不要停下来等确认。`
   - 写明**只许写哪个目录**、**不许改 skill 目录**
   - 要求产出一个结构化文件（如 `work/result.json`）——判定成败要看产物，不要只看 stdout
   - 涉及已有 skill / 脚本 / 文档时，把关键**绝对路径**写进去，别让它猜
   - 末尾加：`不要判断已跑过就跳过，每一步都要实际执行命令`
4. **生成脚本**：从 `_template/run.sh` 复制到 `tasks/run.sh`，替换
   `{{TASK_NAME}}` `{{MODEL}}` `{{TIMEOUT}}` `{{ALLOWED_TOOLS}}` `{{MAX_TURNS}}` `{{REQUIRE_BIGDATA}}`。
   **任务会碰 Spark/Hive/HDFS 就把 `REQUIRE_BIGDATA` 填 1** —— 开跑前先卡一道环境检查，
   否则任务会先花十几分钟走到取数那步，才在 Spark 侧炸一句 `core-site.xml not found`，
   白烧一轮 token 和一个 cron 槽
5. **挂 crontab**（幂等，且自动备份条目）：
   ```bash
   bash /home/jovyan/schedule_task/_shared/add_task.sh <任务名> "<cron表达式>" [多久没跑算异常/小时]
   ```
   不要手写 `crontab -` 管道——`add_task.sh` 会强制补上 `/bin/bash` 和 `>>日志 2>&1`，
   这两样漏一个就出事（见下"注意事项"）。
6. **立刻手动跑一轮验证**：`bash /home/jovyan/schedule_task/<任务名>/tasks/run.sh`，
   看 `logs/last_status.json` 的 `success`。**别等到点了才发现不通。**
7. **告诉用户**：任务名、cron 表达式、脚本路径、日志路径、验证结果

### 步骤 2b：Session cron

1. 构造 prompt（同样加强制重跑前缀）
2. `CronCreate`：一次性 `recurring=false, durable=true`；长期 `recurring=true, durable=true`，
   prompt 末尾加续期指令
3. 告诉用户 CronID、cron 表达式、recurring/one-shot

### 步骤 3：可选 — 健康检查

`_shared/check_all_health.sh`（正常静默）。它查三类**不报错的故障**：任务该跑却
超期没跑、跑了但工具被权限拒、脚本在而 crontab 里没条目。

## 目录结构

```
/home/jovyan/schedule_task/
├── _shared/
│   ├── claude_env.sh        # HOME/PATH/大数据环境/凭据，被每个 run.sh source
│   ├── capture_env.sh       # 在交互终端跑一次，快照 Spark/Hive/Hadoop 环境
│   ├── runtime_env.sh       # capture_env.sh 生成的快照（600 权限，不含凭据）
│   ├── bigdata_env.sh(.example)  # 手工兜底/覆盖，在快照之后加载
│   ├── preflight.sh         # 空环境体检 + 探 claude 绝对路径（配任务前必跑）
│   ├── claude_bin.env       # preflight 生成：CLAUDE_BIN=/绝对/路径/claude
│   ├── setup_cron.sh        # 装 cron + 起进程 + 从 crontab.txt 恢复条目
│   ├── crontab.txt          # add_task.sh 自动维护的条目备份（pod 重启救命用）
│   ├── add_task.sh          # 幂等挂载 crontab + 写 meta.json + 备份
│   ├── check_all_health.sh  # 健康检查（异常才出声）
│   └── list_tasks.sh        # 汇总
├── install.sh               # 解包后跑一次：补执行位 + 注册 skill + 装 cron + 体检
├── _template/run.sh
└── <任务名>/
    ├── meta.json            # cron 表达式 + 陈旧阈值
    ├── logs/                # *.log / *.stream.jsonl / last_status.json / latest.log
    ├── tasks/{run.sh,prompt.md}
    └── work/                # claude 的固定 cwd，产物落这里
```

## 注意事项

**环境类 —— "调不起来"**

- `PATH`：cron 只有 `/usr/bin:/bin`，claude 是 node CLI 且通常装在 `~/.npm-global/bin`
  之类的地方 → `command not found`。用 `preflight.sh` 探出的绝对路径。
- `HOME`：crontab 装在 root 名下时 `HOME=/root`，claude 会去读 `/root/.claude` —— 登录态、
  `settings.json`、`~/.claude/skills` 全部读不到，表现就是"没权限 / 找不到 skill"。
  `claude_env.sh` 里显式 `export HOME=/home/jovyan`（可用 `CLAUDE_TASK_HOME` 覆盖）。
- crontab 行必须 `/bin/bash <脚本>`：cron 默认 `SHELL=/bin/sh`。
- crontab 行必须 `>> 日志 2>&1`：否则 cron 拿输出去发邮件，pod 里没 MTA = 日志直接丢。
- crontab 行里的 `%` 是换行符，路径含 `%` 会被静默截断。
- `LANG=C.UTF-8`：否则中文提示词在某些 locale 下会变成 `?`。
- `DISABLE_AUTOUPDATER=1`：cron 下别自动更新（写盘、变慢、版本漂移）。

**大数据栈 —— "core-site.xml not found / import pyspark 失败"**

- cron 不加载 Jupyter 启动脚本，`JAVA_HOME`(`/usr/local/java`)、`HADOOP_HOME`
  (`/usr/local/hadoop`)、`HADOOP_CONF_DIR`(`.../etc/hadoop`)、`SPARK_HOME`
  (`/usr/local/spark`)、`HIVE_CONF_DIR`(`/usr/local/hive/conf`)、`PYSPARK_PYTHON`、
  `PYTHONPATH`(spark/python + py4j)、以及 PATH 里的 `spark/bin`、`hadoop/bin`、
  `hive/bin`、`java/bin` **全部消失**。用 `capture_env.sh` 快照 + `claude_env.sh` 恢复。
- **不要手写 export 清单**：会漏（py4j 的 zip 带版本号、`PYSPARK_DRIVER_PYTHON`），
  也会烂（运维换版本后路径失效，且不报错）。快照是"能跑通的那份环境原样搬过去"。
- `PYSPARK_PYTHON` **必须绝对路径**：相对路径在 cron 的 cwd 下解析不出来，而且是
  worker 侧才炸，报错很隐晦。
- 环境要一路继承到孙进程：`cron → run.sh → claude → Bash 工具 → python3 → SparkSubmit`。
  在 `run.sh` 里 `export` 就够（claude 把环境整份传给子进程），但**必须在调 claude 之前**。
  `preflight.sh --deep` 就是专门验这条链的。
- 任务用大数据栈时 `REQUIRE_BIGDATA=1`：开跑前卡一道，别等十几分钟后才炸。
- 快照文件 `runtime_env.sh` 是明文（600 权限），**凭据类变量一律不入快照**，
  由 `claude_env.sh` 单独从 `~/.claude/settings.json` 读。

**凭据类 —— "登录/401"**

- auth 从 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` / `env.ANTHROPIC_BASE_URL`
  读，**不硬编码**。必须用 `.get()` 链取值并显式判空，取不到就 fail fast：若写成下标
  `['env']['ANTHROPIC_AUTH_TOKEN']`，键缺失时 python 抛错、`$( )` 拿到空串，脚本又没
  `set -e`，于是**带着空 token 一路跑到 claude 报 401**，日志里看不出根因。
- 空串比不设更糟（CLI 会当成"显式设了空凭据"），`claude_env.sh` 里会 `unset` 掉。
- **绝不把 token echo 进日志**，只报"已设/未设 + 位数"。
- 别让业务侧的密钥变量和 CLI 凭据撞名（`ANTHROPIC_*` / `API_KEY` 这些会被子进程继承）。

**调用类 —— "跑了但什么也没干"**

- `--permission-mode dontAsk`：非交互专用，永不弹提示，不在 allow 名单里的直接拒绝
  并继续。**不设的话默认 `manual`**，`-p` 下遇到要确认的工具会静默拒掉——任务"成功"
  返回、实际什么也没做，是最难查的一类故障。
- `--allowedTools` 逗号或空格分隔均可。默认给 `Bash,Read,Write,Edit,Glob,Grep,Skill`
  ——**`Skill` 必须给**，这类任务十有八九就是让它去跑另一个 skill。
- 优先点名工具，不用 `--dangerously-skip-permissions`（有数据访问能力的机器上代价太高）。
- **exit 0 ≠ 成功。** 判定看 `--output-format stream-json` 最后一条 result 事件：
  `{"type":"result","subtype":"success","is_error":false,"permission_denials":[],...}`。
  `permission_denials` 非空 = 有工具被拒，这是 allowedTools 配漏的直接证据。
- `timeout -k 10 <秒>`：GNU timeout 默认把子进程放独立进程组并对整组发信号——claude
  带 Bash 会拉起孙进程，只杀它自己的话管道不 EOF，脚本会一直挂着。
- `flock -n` 防重入：上一轮没跑完就跳过，否则堆积起来一起抢 rate limit。
- cwd 固定成任务的 `work/`：Claude Code 按工作目录建"项目"，每次换 cwd 会把会话散成
  一堆同名项目，目录信任状态也无法复用。
- 日志按 14 天清理：`stream-json` 很啰嗦，不清会把盘写满。

**运维类**

- pod 是 k8s 容器，重启后 cron 包、cron 进程、crontab 条目**全会丢**。`setup_cron.sh`
  能一键恢复三样（条目从 `_shared/crontab.txt` 灌回）。pod 重启后先跑它，再跑 `preflight.sh`。
- session recurring 任务 7 天自动过期，需续期链。
- 任务名：小写+下划线、简短能辨识。
