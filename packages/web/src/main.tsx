import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { I18nProvider } from './lib/i18n.tsx'
import './index.css'

const root = document.getElementById('root')
if (root === null) throw new Error('缺少 #root 挂载点')

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
