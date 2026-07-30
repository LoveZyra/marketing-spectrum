import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import { initI18n } from './i18n/config.js'

// Side effects last. katex's stylesheet used to be imported here, right after
// index.css so it could override the Tailwind layers; it now ships with the
// maths plugins in `shared/markdown/katexPlugins`, injected at runtime, which
// lands it after index.css in the cascade just the same.
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root'))

const render = () => root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Translations are fetched now rather than bundled, so the first render waits
// for them. Without the wait every string would render as its key for a frame.
// A failed load still renders: i18next serves keys, which is a degraded UI but
// a reachable one, and far better than a blank page.
initI18n()
  .catch((error) => {
    console.error('[i18n] Initialization failed; rendering untranslated:', error)
  })
  .finally(render)
