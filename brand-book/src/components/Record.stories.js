export default {
  title: "Components/Record",
  parameters: {
    docs: {
      description: {
        component:
          "The record components specific to LinkNMS. Planned vs. actual and owner vs. builder are distinguished by label and position first, colour second.",
      },
    },
  },
};

export const TradeContractRow = {
  name: "Trade contract row",
  render: () =>
    `<div class="listrow">
      <div><div class="t">Electrical — 2nd fix</div><div class="s">SparkWorks Lda · 3 pending approvals</div></div>
      <span class="badge warn">Needs attention</span>
    </div>`,
};

export const Timeline = {
  name: "Timeline — planned vs. actual",
  render: () =>
    `<div class="tl">
      <div class="r"><span class="lab">Planned</span><span class="bar planned" style="width:78%"></span><span class="val">3–17 Mar</span></div>
      <div class="r"><span class="lab">Actual</span><span class="bar actual" style="width:52%"></span><span class="val">5–14 Mar</span></div>
    </div>`,
};

export const BudgetLineItem = {
  name: "Budget line item",
  render: () =>
    `<table class="budget">
      <thead><tr><th>Item</th><th>Planned</th><th>Actual</th><th>Delta</th></tr></thead>
      <tbody>
        <tr><td>Foundations</td><td class="num">€ 42,000</td><td class="num">€ 43,900</td><td class="num delta up">+€1,900</td></tr>
        <tr><td>Framing</td><td class="num">€ 61,000</td><td class="num">€ 58,200</td><td class="num delta down">−€2,800</td></tr>
      </tbody>
    </table>`,
};

export const ChangeRecord = {
  name: "Change record — tamper-evident",
  render: () =>
    `<div class="change">
      <span class="who">J. Lima</span> <span class="when">· 12 Mar 2026, 14:08</span>
      <span class="badge edit" style="margin-left:6px">Edited</span>
      <div class="vals"><span class="old">€ 3,200</span><span class="arrow">→</span><span>€ 4,050</span></div>
    </div>`,
};
