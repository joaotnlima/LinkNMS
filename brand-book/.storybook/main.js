/** @type { import('@storybook/html-vite').StorybookConfig } */
const config = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.js"],
  addons: ["@storybook/addon-essentials"],
  framework: { name: "@storybook/html-vite", options: {} },
  staticDirs: ["../public"],
};
export default config;
