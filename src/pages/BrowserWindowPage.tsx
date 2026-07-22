import React, { useEffect, useState, useRef } from 'react';
import { useTitleBarStore } from '../stores/titleBarStore';

// 简化的内置浏览器窗口
// 实际上由于 Electron 的限制，iframe 无法直接加载大部分外部网站（同源/CSP限制）
// 但为了满足"不显示 Electron 默认菜单和图标"的需求，我们可以使用 <webview> 标签
// 而 <webview> 需要在 webPreferences 中启用 webviewTag: true
// 在本项目中，可能更简单的方法是：
// 1. Electron 主进程直接创建一个普通的 BrowserWindow
// 2. 加载一个空白的 HTML，其中包含 TitleBar 和 <webview>
// 或者
// 3. (当前方案) React 页面中使用 <webview>
// 注意：这需要在主进程 main.ts 的 webPreferences 中为 browser-window 启用 webviewTag

const BrowserWindowPage = () => {
    const [params, setParams] = useState<{ url: string; title: string }>({ url: '', title: 'Browser' });
    const [isLoading, setIsLoading] = useState(true);
    const [pageTitle, setPageTitle] = useState('加载中...');
    const webviewRef = useRef<any>(null);
    const setTitleBarTitle = useTitleBarStore(state => state.setTitle);

    // 标题交给窗口级标题栏（App 渲染），本页只把当前页标题写进 store
    useEffect(() => {
        setTitleBarTitle(pageTitle);
        return () => setTitleBarTitle(null);
    }, [pageTitle, setTitleBarTitle]);

    useEffect(() => {
        // 从 URL 参数获取
        const searchParams = new URLSearchParams(window.location.hash.split('?')[1]);
        const url = searchParams.get('url') || '';
        const title = searchParams.get('title') || '';

        // 解码 URL
        const decodedUrl = decodeURIComponent(url);
        const decodedTitle = decodeURIComponent(title);

        setParams({ url: decodedUrl, title: decodedTitle });
        if (decodedTitle) setPageTitle(decodedTitle);

        // 设置窗口标题
        document.title = decodedTitle || '浏览器';
    }, []);

    useEffect(() => {
        const webview = webviewRef.current;
        if (!webview) return;

        // 监听加载事件
        const handleDidStartLoading = () => setIsLoading(true);
        const handleDidStopLoading = () => {
            setIsLoading(false);
            // 尝试获取网页标题
            try {
                if (!params.title) {
                    setPageTitle(webview.getTitle());
                }
            } catch (e) { }
        };

        // 监听标题变化
        const handlePageTitleUpdated = (e: any) => {
            if (!params.title) {
                setPageTitle(e.title);
                document.title = e.title;
            }
        };

        webview.addEventListener('did-start-loading', handleDidStartLoading);
        webview.addEventListener('did-stop-loading', handleDidStopLoading);
        webview.addEventListener('page-title-updated', handlePageTitleUpdated);

        return () => {
            webview.removeEventListener('did-start-loading', handleDidStartLoading);
            webview.removeEventListener('did-stop-loading', handleDidStopLoading);
            webview.removeEventListener('page-title-updated', handlePageTitleUpdated);
        };
    }, [params.title]);

    if (!params.url) return null;

    return (
        <div className="browser-window" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#fff' }}>
            {/* 简单的进度条 */}
            {isLoading && (
                <div style={{
                    height: '2px',
                    background: 'var(--primary)',
                    width: '100%',
                    position: 'fixed',
                    top: 'var(--window-chrome-height)',
                    zIndex: 9999,
                    animation: 'loading 2s infinite linear'
                }} />
            )}

            {/* 
        webview 是 Electron 特有的标签，类似于 iframe 但权限更高 
        注意: 需要在 main.ts 的 createBrowserWindow 中的 webPreferences 设置 webviewTag: true
      */}
            <webview
                ref={webviewRef}
                src={params.url}
                style={{ flex: 1, display: 'inline-flex' }}
                allowpopups={true}
                // 禁用 nodeIntegration 保证安全
                webpreferences="contextIsolation=yes, nodeIntegration=no"
            />

            <style>{`
        @keyframes loading {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
        </div>
    );
};

export default BrowserWindowPage;
