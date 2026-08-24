export default {
  title: "Brand/Typography",
  parameters: {
    docs: {
      description: {
        component:
          'One family: the brand system-sans stack `system-ui, -apple-system, "Segoe UI", sans-serif`. Neutral and universally available — the mark should feel like a document. Values use tabular figures so columns and deltas align.',
      },
    },
  },
};

export const Scale = {
  render: () =>
    `<table class="scale">
      <thead><tr><th>Token</th><th>Specimen</th><th>Size / LH</th><th>Weight</th></tr></thead>
      <tbody>
        <tr><td>display</td><td style="font-size:28px;line-height:1.2;font-weight:600">Project title</td><td>28 / 34</td><td>600</td></tr>
        <tr><td>heading</td><td style="font-size:20px;font-weight:600">Timeline &amp; Budget</td><td>20 / 28</td><td>600</td></tr>
        <tr><td>subheading</td><td style="font-size:16px;font-weight:600">Trade contract</td><td>16 / 24</td><td>600</td></tr>
        <tr><td>body</td><td style="font-size:14px">Default UI and prose text.</td><td>14 / 22</td><td>400</td></tr>
        <tr><td>data</td><td class="num" style="font-size:14px">€ 128,450 · −€3,200</td><td>14 / 20</td><td>500 · tabular</td></tr>
        <tr><td>caption</td><td style="font-size:12px;color:var(--muted)">Edited 12 Mar · J. Lima</td><td>12 / 16</td><td>400</td></tr>
      </tbody>
    </table>`,
};
