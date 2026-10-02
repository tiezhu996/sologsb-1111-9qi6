# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / MergeCenter
│       ├── router/index.tsx   # 路由表
│       ├── sync/              # 离线差量合并：clock 版本向量 / merge 纯函数对账 / syncDb 导入导出 / labels
│       └── utils/             # recovery.ts / db.ts / export.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |
| `/merge` | 差量合并 | 两台笔记本离线差量包的导出、逐项对账、整包写入与待处理区裁决 |

## 离线差量合并（两台笔记本对账）

野外两台笔记本分开录数据，回驻地后**不再需要整库覆盖**，在「差量合并」页用 JSON 差量包离线交换：

1. **导出标来源与基线**：每条记录都带来源节点（`nodeId`）与版本向量（基线版本）；支持全量包（首次交换）与按对方节点裁剪的增量包，删除以墓碑（tombstone）形式随包带走。
2. **导入先逐项对账**：按钻孔 → 回次 → 岩芯箱 → 岩性顺序，用版本向量判定「仅对方改过 / 仅本地改过 / 两边都改过 / 一边删一边改」，确认前只出对账预览，不写库。
3. **已确认事实受保护**：本地已确认的终孔事实（终孔深度 > 0、终孔日期）与样品事实（样品号非空）不会被导入包自动覆盖；确需采用对方时由编录员在待处理区显式选定。
4. **冲突进待处理区**：同一对象两边都改过（含一方删除）、或自动写入会产生重复箱号 / 重叠岩性区间的，一律留在待处理区，由编录员逐项选定本地或对方版本；**待处理项不进入其他对象的自动合并**，也不阻塞无关对象。
5. **整包写入可重试**：写入前先把四张旧表复制到备份表；正式写入是单事务，任一步失败整体回滚、四张旧表保持不动，可直接重试或一键回滚到合并前。确认无误后可清除备份。
6. **旧数据兼容**：升级前缺少来源字段的历史记录按统一规则回填为公共祖先 `__legacy__@1`，两台机器在旧库上各自改动能被正确识别；删除会释放箱号/岩性区间，避免重复生成。

相关代码在 `frontend/src/sync/`：`clock.ts`（版本向量）、`merge.ts`（纯函数对账）、`syncDb.ts`（导出/导入/备份/裁决）、`MergeCenter.tsx`（页面）；对账规则有单测 `src/sync/merge.test.ts`，整包事务有集成测试 `src/sync/syncDb.test.ts`（`npm test`）。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`meta`、`tombstones`（逻辑删除）、`pending`（待处理区）、`holesBackup/runsBackup/boxesBackup/lithosBackup`（整包写入前的四张旧表备份）。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 增加差量合并所需表，并把缺少来源字段的旧记录统一回填为公共祖先 `__legacy__@1`。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
