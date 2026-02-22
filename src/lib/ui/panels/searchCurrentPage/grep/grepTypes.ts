export interface TaggedLine {
  text: string;
  lower: string;
  tag: string;
  nodeRef?: WeakRef<Node>;
  ancestorHeading?: string;
  href?: string;
}

export interface LineCache {
  all: TaggedLine[] | null;
  code: TaggedLine[] | null;
  headings: TaggedLine[] | null;
  links: TaggedLine[] | null;
  images: TaggedLine[] | null;
  observer: MutationObserver | null;
  invalidateTimer: ReturnType<typeof setTimeout> | null;
}
