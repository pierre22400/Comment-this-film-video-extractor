/// <reference types="vite/client" />
/// <reference types="chrome" />

// CRXJS : import d'un script bundlé en IIFE, injectable via chrome.scripting.
declare module '*?script&iife' {
  const src: string
  export default src
}
