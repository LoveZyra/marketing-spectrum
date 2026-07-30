# marketing-spectrum —— 营销诊断平台(Prism 网关 + 营销诊断 API/Skill)

> 取名自 Prism(棱镜):网关是入口,诊断把营销活动数据分解成结论光谱 ——
> 哪里漏水、该推谁,一次照出来。

一个仓库两个顶层目录:

**`prism/`** —— 网关入口服务(Node)。公司网关只转发 8080 且 8080 归它,营销诊断 API
挂在它底下走反代(`/api/ma/*` → 回环 8092),由 `server/services/ma-service.js` 托管自启。
生产跑法 `npm run server`(已 build)/ `npm start`(重新 build)。并入本仓库时未携带原 git 历史。

**`ma_server/`** —— 营销诊断侧全部代码:

- `营销诊断/api模式测试/` —— **API 服务本体**(方案 C:`ma_core.py` 服务底座 +
  `ma_pipeline.py` 业务流水线 + `ma_api_c.py` 入口;`ma_api_b.py` 为备选的全模型编排方案)、
  五套回归(534 条断言,`fixtures/` 是其中 5 条真实回放断言的依赖,**别删**)、
  `install.sh` 打包安装、`run_ma_server.sh` 整轮联调、`restart_prism.sh` 一键重启、
  `preflight_ma_server.py` 上机体检。**部署步骤与接口契约以 `运行说明.md` 为准。**
- `marketing-audit/` —— 营销诊断 skill(诊断规则、方法论、渲染器)。服务器部署位置
  `~/.claude/skills/marketing-audit/`,改这里的文件要拷过去才生效。
- `hdfs-data/` —— 取数 skill(Hive → 本地 parquet)。
- `营销诊断/私域平台诊断/` —— 离线流程(圈人口径的参照实现)。

## 接口一句话

`POST /api/ma/diagnose`(入参只有 `activity_id` / `date` / `meta`)→ 轮询
`GET /api/ma/jobs/{id}` → `GET /api/ma/jobs/{id}/result` 出六个字段:
`job_id / state / activity_id / mode / report_url / rules`。只读特征表、不写任何线上表、
只输出需要推送的人群。演进过程见 `CHANGELOG.md`。

## 没进库的东西(.gitignore 兜着)

运行产物(`jobs/`、`runs/` —— 含用户级数据,**不得入库**)、依赖与构建产物
(`node_modules/`、`dist-server/`)、备份(`*.bak_*`)、fix/部署包(由源码可重打)、
密钥(`ma-env.local.sh`、`.env`)。历史测试证据与复盘文档留在原目录未入库,
结论已浓缩进 `CHANGELOG.md`;测试机脚本里的 `ma-real-test-key` 是测试口令,
仓库范围扩大前先换掉。
