import '@myco/ui-kit/biolum.css'
import './index.css'
import './home.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ImgViewerApp } from './ImgViewer'

// 图片查看器子窗口（WebviewWindow label=imgview）以 index.html#imgview 启动——
// 同一份 dist 两个入口：hash 路由分流，主窗=App、查看器窗=ImgViewerApp。
const isImgViewer = window.location.hash.startsWith('#imgview')

createRoot(document.getElementById('root')!).render(isImgViewer ? <ImgViewerApp /> : <App />)
