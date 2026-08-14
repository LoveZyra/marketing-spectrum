declare module 'react-syntax-highlighter';
declare module 'react-syntax-highlighter/dist/esm/styles/prism';
// 按需加载的 Prism 入口。languageLoaders 覆盖 refractor 全部语言,行为与同步的
// `Prism` 一致,但每种语法单独成块 —— 入口块因此从 227 kB gzip 降到 13 kB。
declare module 'react-syntax-highlighter/dist/esm/prism-async-light';
