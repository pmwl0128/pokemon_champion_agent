/// <reference types="vite/client" />

declare module "*.svg?url" {
  const url: string;
  export default url;
}
