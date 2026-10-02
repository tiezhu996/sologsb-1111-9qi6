import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { routes } from './router';
import './styles.css';

dayjs.locale('zh-cn');

function RoutesView() {
  return useRoutes(routes);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#3b6c8f',
          borderRadius: 6,
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <RoutesView />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
