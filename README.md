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
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor
│       ├── router/index.tsx   # 路由表
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
| `/merge` | 差量合并 | 两台编录本离线差量包导出/导入对账：来源与基线版本标注、逐项三向对账、终孔/样品事实保护、待处理区选版本、整包原子写入可重试 |

## 野外离线差量合并

两台笔记本各自录入、回驻地合账时不再整库覆盖。入口为左侧「差量合并」（或顶栏按钮）。

- **导出差量包**：包内标注来源设备（`_origin.deviceId/deviceName`）与基线版本（每条业务记录的内容修订号 rev，FNV-1a，剥离来源字段后按稳定序列化计算）。可导「通用全量包」（首次对接），或对已对接对端导「增量包」（只含自上次发包以来的新增/修改/删除墓碑）；导出后推进本机对该对端的同步游标。
- **导入先对账后落库**：按钻孔 → 回次 → 岩芯箱 → 岩性区间逐项做三方比对（本机 / 导入 / 共同祖先=包内基线∪本机发包游标）。只有对端改的自动并入，只有本机改的保留，两边都改的进**待处理区**由编录员逐字段对照后选定版本。
- **事实保护**：本机已确认的终孔（终孔深度/终孔日期）与已登记样品号不会被导入覆盖——这类字段在对账中锁定，编录员可选「并入非保护字段」（其余字段采用导入、事实字段强制保留本机），含样品的区间也不得随包删除。
- **挂起隔离**：待处理钻孔之下的回次/箱/岩性不自动合并；与待处理回次、待处理箱、待处理岩性区间在同孔同号或深度重叠的对象一律挂起，避免重复生成回次、箱号或岩性区间。挂起/待处理项不进入任何其他对象的自动合并。
- **自然键防重复**：两台机器分开录时 id 不同，钻孔按孔号、回次按同孔回次号/深度重叠、岩芯箱按同孔箱号/装箱深度、岩性按同孔区间重叠识别为同一对象；两边独立新建的同一对象即使内容相同也进待处理区人工确认。
- **整包原子写入**：所有自动项与已决议项在单个 IndexedDB 事务内写入，事务内再做孔号/箱号/回次号/岩性区间唯一校验、父孔存在与孤儿守卫、陈旧暂存检测；任一失败整体回滚，**四张旧表原样保留**，暂存保留可直接重试。应用成功后未处理项继续留在待处理区。
- **旧数据兼容**：`db.version(3)` 升级为历史记录回填 `_origin`（视为该机初版）；整库备份恢复（`importBackup`）后也兜底回填，缺来源字段不影响对账。

差量包为纯 JSON（`kind=gbdrillcore-delta`），与全量备份（`导出备份`）并存，全程无后端，可走 U 盘/即时通讯传递。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`meta`、`mergeStaging`（差量导入暂存区）。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 增加暂存表并为四张旧表回填 `_origin` 来源/修订号。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 离线测试

对账引擎与整包应用均不依赖浏览器，可在 Node 下离线跑：

```bash
cd frontend
npm install
npm run test:merge       # 三向对账规则（20 例：事实保护/挂起隔离/自然键防重复/旧数据回填…）
npm run test:merge-io    # IndexedDB 整包事务（fake-indexeddb，9 例：原子回滚/重试/增量导出/墓碑）
```
