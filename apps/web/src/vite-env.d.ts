/// <reference types="vite/client" />

import { type Component } from 'vue';

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

declare module '*.vue' {
  const component: Component;
  export default component;
}
