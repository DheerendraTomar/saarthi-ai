// Inline SVG icons (no icon fonts or external images: the bundle must stay CSP-safe).
const common = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true } as const;

export function GearIcon() {
  return (
    <svg {...common}>
      <path d="M9.1 1l.4 1.9c.4.1.8.3 1.1.5l1.7-1 1.3 1.3-1 1.7c.2.3.4.7.5 1.1L15 6.9v1.9l-1.9.4c-.1.4-.3.8-.5 1.1l1 1.7-1.3 1.3-1.7-1c-.3.2-.7.4-1.1.5L9.1 15H7.2l-.4-1.9c-.4-.1-.8-.3-1.1-.5l-1.7 1-1.3-1.3 1-1.7c-.2-.3-.4-.7-.5-1.1L1.3 9.1V7.2l1.9-.4c.1-.4.3-.8.5-1.1l-1-1.7L4 2.7l1.7 1c.3-.2.7-.4 1.1-.5L7.2 1h1.9zM8.1 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...common}>
      <path d="M6 1h4l.5 1H14v1.5H2V2h3.5L6 1zm-2.5 4h9l-.7 9.1c0 .5-.5.9-1 .9H5.2c-.5 0-1-.4-1-.9L3.5 5zm3 1.5v6.5h1V6.5h-1zm2 0v6.5h1V6.5h-1z" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg {...common}>
      <path d="M2 3h2v2H2V3zm4 .5h8V5H6V3.5zM2 7h2v2H2V7zm4 .5h8V9H6V7.5zM2 11h2v2H2v-2zm4 .5h8V13H6v-1.5z" />
    </svg>
  );
}
