import React from 'react'
import { createRoot } from 'react-dom/client'
import { connect } from 'ciphertalk-plugin-sdk'
import App from './App'
import './styles.css'

// connect() 完成宿主握手：注入主题变量 + .dark class（见 styles.css 说明）。
// 握手成功后再挂载 React，确保首帧就是正确主题。
connect().then((api) => {
  createRoot(document.getElementById('app')!).render(
    <React.StrictMode>
      <App api={api} />
    </React.StrictMode>,
  )
})
