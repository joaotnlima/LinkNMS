import "../src/styles/tokens.css";
import "../src/styles/brand.css";

/** @type { import('@storybook/html').Preview } */
const preview = {
  parameters: {
    layout: "padded",
    backgrounds: {
      default: "Paper",
      values: [
        { name: "Paper", value: "#fcfcfb" },
        { name: "Sunken", value: "#f4f3f0" },
        { name: "Ink", value: "#0b0b0b" },
      ],
    },
    options: {
      storySort: {
        order: [
          "Introduction",
          "Brand",
          ["Logo", "Colour", "Typography", "Voice"],
          "Components",
        ],
      },
    },
    controls: { expanded: true },
  },
  tags: ["autodocs"],
};

export default preview;
