export default {
  title: "Components/Party invite",
  parameters: {
    docs: {
      description: {
        component:
          "A person invited to a role on the build. The avatar tint follows the party (owner blue / contractor orange) but the role is always spelled out with a party tag, so side is set by label + position first, colour second. States: invited (pending), joined. See flows/01-bootstrap-project.md, screens 4–6.",
      },
    },
  },
  argTypes: {
    name: { control: "text" },
    email: { control: "text" },
    initials: { control: "text" },
    party: { control: "inline-radio", options: ["owner", "builder"] },
    role: { control: "text" },
    status: { control: "inline-radio", options: ["pending", "joined"] },
  },
  args: {
    name: "Nuno Ferreira",
    email: "nuno@ferreiraconstrucao.pt",
    initials: "NF",
    party: "builder",
    role: "General Contractor",
    status: "pending",
  },
  render: ({ name, email, initials, party, role, status }) => {
    const badge =
      status === "joined"
        ? `<span class="badge ok">Joined</span>`
        : `<span class="badge warn">Invite sent</span>`;
    const sub = status === "joined" ? email : `${email} · awaiting reply`;
    return `<div style="display:flex;flex-direction:column;gap:8px;max-width:420px">
      <div class="row"><span class="party ${party === "builder" ? "builder" : "owner"}">${role}</span>${badge}</div>
      <div class="invite">
        <span class="av ${party}">${initials}</span>
        <span class="who"><span class="nm">${name}</span><span class="em">${sub}</span></span>
      </div>
    </div>`;
  },
};

export const Pending = {};
export const Joined = { args: { status: "joined" } };
export const OwnerRep = {
  name: "Owner's representative",
  args: { name: "Marta Almeida", email: "marta@casa-almeida.pt", initials: "MA", party: "owner", role: "Owner", status: "joined" },
};
