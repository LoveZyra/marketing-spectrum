import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import { initI18n } from './i18n/config.js'

// Side effects last. katex's stylesheet is not imported here: it ships with the
// maths plugins in `shared/markdown/katexPlugins` and is injected at runtime,
// which still lands it after index.css in the cascade so it can override the
// Tailwind layers.
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root'))

const render = () => root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Translations are fetched rather than bundled, so the first render waits for
// them; otherwise every string would render as its key for a frame.
// A failed load still renders: i18next serves keys, which is a degraded UI but
// a reachable one, and far better than a blank page.
initI18n()
  .catch((error) => {
    console.error('[i18n] Initialization failed; rendering untranslated:', error)
  })
  .finally(render)
