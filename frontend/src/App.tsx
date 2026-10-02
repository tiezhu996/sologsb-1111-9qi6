import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Typography, App as AntApp, Button, Space, Badge } from 'antd';
import {
  CompassOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ProfileOutlined,
  BarsOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { seedIfEmpty } from './utils/seed';
import { downloadText, exportBackupJson } from './utils/export';
import { useHoleStore } from './stores/holeStore';
import { useRunStore } from './stores/runStore';
import { useBoxStore } from './stores/boxStore';
import { useLithoStore } from './stores/lithoStore';
import { db } from './utils/db';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Text } = Typography;

const MENU_ITEMS = [
  { key: '/', icon: <CompassOutlined />, label: <Link to="/">工作台</Link> },
  { key: '/holes', icon: <DatabaseOutlined />, label: <Link to="/holes">钻孔台帐</Link> },
  { key: '/runs', icon: <BarsOutlined />, label: <Link to="/runs">回次记录</Link> },
  { key: '/boxes', icon: <ProfileOutlined />, label: <Link to="/boxes">岩芯箱</Link> },
  { key: '/lithology', icon: <ExperimentOutlined />, label: <Link to="/lithology">岩性编录</Link> },
  { key: '/merge', icon: <SwapOutlined />, label: <Link to="/merge">差量合并</Link> },
];

/** 应用外壳：左侧导航 + 顶部导出备份，负责一次性的本地数据装载 */
export default function App() {
  const { message } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const location = useLocation();

  const refreshPendingCount = () => {
    db.pending.count().then(setPendingCount).catch(() => undefined);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await seedIfEmpty();
        await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos()]);
        if (alive) refreshPendingCount();
      } catch (error) {
        message.error(`本地数据装载失败：${(error as Error).message}`);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos, message]);

  // 从待处理区返回后刷新角标
  useEffect(() => {
    refreshPendingCount();
  }, [location.pathname]);

  const selectedKey =
    MENU_ITEMS.map((item) => item.key)
      .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
      .sort((a, b) => b.length - a.length)[0] ?? '/';

  const menuItems = MENU_ITEMS.map((item) =>
    item.key === '/merge' && pendingCount > 0
      ? {
          ...item,
          label: (
            <Badge count={pendingCount} size="small" offset={[10, -2]}>
              <Link to="/merge">差量合并</Link>
            </Badge>
          ),
        }
      : item,
  );

  const handleExport = async () => {
    const json = await exportBackupJson();
    downloadText(`gbdrillcore-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    message.success('已导出 IndexedDB 全量 JSON 备份');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" width={204} style={{ background: '#2b3a46' }}>
        <div style={{ padding: '16px 16px 8px' }}>
          <Title level={5} style={{ color: '#fff', margin: 0 }}>
            钻孔岩芯编目台
          </Title>
          <Text style={{ color: '#9fb4c2', fontSize: 12 }}>gbdrillcore · 纯前端本地存储</Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} style={{ background: 'transparent' }} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text strong>矿区钻孔岩芯编目台</Text>
          <Space>
            <Link to="/merge">
              <Badge count={pendingCount} size="small" offset={[-4, 4]}>
                <Button icon={<SwapOutlined />}>差量合并</Button>
              </Badge>
            </Link>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出备份
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          {ready ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Content>
        <Footer style={{ textAlign: 'center', color: '#8a99a5', padding: '12px 0' }}>
          数据保存在浏览器 IndexedDB（gbdrillcore-db），不依赖后端服务
        </Footer>
      </Layout>
    </Layout>
  );
}
