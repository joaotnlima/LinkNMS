import "../src/styles/tokens.css";
import "../src/styles/brand.css";
import "../src/styles/landing.css";

/** @type { import('@storybook/html').Preview } */
const preview = {
  parameters: {
    layout: "padded",
    backgrounds: {
      default: "Paper",
      values: [
        { name: "Paper", value: "#fbfaf7" },
        { name: "Sunken", value: "#f4f3f0" },
        { name: "Ink", value: "#16181d" },
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
