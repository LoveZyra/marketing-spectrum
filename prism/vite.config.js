import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

/**
 * KaTeX 只保留 woff2 字体(cp 轮,G2)。
 *
 * katex.min.css 的每个 @font-face 都列了 woff2 / woff / ttf 三份 src,Vite 会把
 * 被引用到的**全部** 60 个字体文件拷进 dist —— 其中 woff/ttf 合计约 876 KB,
 * 而现代浏览器永远只取列表里第一个能用的格式(woff2),那 40 个文件一次也不会
 * 被请求。这里把 src 列表裁到只剩 woff2,dist 里就只留 20 个 woff2(约 292 KB)。
 *
 * woff2 的支持面:Chrome 36+/Firefox 39+/Safari 10+/Edge 14+ —— 早已是全员基线。
 */
function katexWoff2Only() {
  return {
    name: 'prism-katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !/\.css(\?|$)/.test(id)) return null
      const next = code.replace(/src:([^;{}]*?)(?=[;}])/g, (match, srcList) => {
        if (!srcList.includes('woff2')) return match
        const kept = srcList.split(',').map((part) => part.trim()).filter((part) => part.includes('.woff2'))
        return kept.length > 0 ? `src:${kept.join(',')}` : match
      })
      return next === code ? null : { code: next, map: null }
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 8080

  return {
    plugins: [react(), katexWoff2Only()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // Function form, not the object form, and deliberately so.
          //
          // The object form seeds a chunk from a package name and then sweeps in
          // everything reachable from it that isn't claimed elsewhere. For
          // CodeMirror that swept up the Babel interop helpers (`_extends`,
          // `_objectWithoutPropertiesLoose`) that `@uiw/react-codemirror` is
          // compiled against — helpers other packages use too. The entry chunk
          // then had to `import` them from `vendor-codemirror`, which made 660 kB
          // of editor a static dependency of first paint. Matching on the module
          // path instead keeps those helpers out, so the vendor chunks contain
          // only their own package's code and stay reachable solely through the
          // `React.lazy` boundaries that load the editor and terminal.
          manualChunks(id) {
            // 必须排在 node_modules 判断之前:这些是源码里的翻译文件。
            //
            // 每个 namespace 一个块 = 10 语种 × 7 namespace = 70 个块,而 i18next
            // 启动时会把当前语言和回退语言的全部 7 个 namespace 都预加载,即
            // 14 个独立请求,首屏渲染又被 initI18n().finally(render) 挡在后面。
            // 按语种归并后变成 2 个请求,其余 8 种语言仍然是懒加载。
            const localeMatch = /[\\/]src[\\/]i18n[\\/]locales[\\/]([^\\/]+)[\\/]/.exec(id)
            if (localeMatch) return `locale-${localeMatch[1]}`

            if (!id.includes('node_modules')) return undefined
            // Must come first. These are one-line interop helpers (`_extends`,
            // `_objectWithoutPropertiesLoose`, tslib's `__awaiter`) that many
            // Babel- and TS-compiled packages share. Rollup groups a module by
            // the set of chunks that reach it, and a manual chunk counts as one
            // of those — so a helper reached from both the entry and
            // `vendor-codemirror` got folded into `vendor-codemirror`, and the
            // entry then had to import 660 kB of editor to get a five-line
            // function. Giving the helpers their own chunk keeps that edge
            // pointing at something tiny.
            if (/node_modules[\\/](@babel[\\/]runtime|tslib)[\\/]/.test(id)) return 'vendor-helpers'
            if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return 'vendor-react'
            }
            if (/node_modules[\\/](@codemirror|@lezer|@uiw[\\/]react-codemirror|codemirror|style-mod|w3c-keyname|crelt)[\\/]/.test(id)) {
              return 'vendor-codemirror'
            }
            if (/node_modules[\\/]@xterm[\\/]/.test(id)) return 'vendor-xterm'
            /*
             * G3:AppContent 一个块 675 kB,里面最大的两坨与"应用逻辑"无关 ——
             * markdown 渲染管线(react-markdown + remark/rehype + katex + 一大堆
             * micromark/mdast/unist 小包)和图标集。把它们拆出去有两个实打实的
             * 好处:两者几乎从不变,浏览器缓存能一直命中(AppContent 每次发版都变);
             * 而且它们各自被多个懒加载面板共享,拆出来之后不会被复制进每一个。
             *
             * 匹配的是**包目录**而不是 import 语句 —— markdown 那条链上有三十多个
             * 上游小包,逐个列出来必然漏,而漏掉的那个会被折回 AppContent。
             */
            if (/node_modules[\\/](react-markdown|remark-.*|rehype-.*|micromark.*|mdast-.*|unist-.*|hast-.*|katex|property-information|space-separated-tokens|comma-separated-tokens|character-entities.*|decode-named-character-reference|bail|trough|vfile.*|unified|is-plain-obj|zwitch|longest-streak|ccount|markdown-table|escape-string-regexp|devlop|html-void-elements|parse-entities|stringify-entities|character-reference-invalid|is-.*-character|estree-.*)[\\/]/.test(id)) {
              return 'vendor-markdown'
            }
            if (/node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons'
            return undefined
          }
        }
      }
    }
  }
})
