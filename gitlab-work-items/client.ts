/** A work item returned by GitLab's REST issues API. */
export interface GitLabWorkItem {
  id: number;
  iid: number;
  type: string;
  title: string;
  description: string;
  state: string;
  webUrl: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/** A hierarchy reference returned by GitLab's GraphQL API. */
export interface GitLabWorkItemReference {
  id: number;
  gid: string;
  iid: number;
  title: string;
  webUrl: string;
}

/** Explicitly distinguishes unreadable hierarchy from an empty hierarchy. */
export type GitLabHierarchy =
  | {
    status: "available";
    parent: GitLabWorkItemReference | null;
    children: GitLabWorkItemReference[];
    complete: boolean;
    nextCursor: string | null;
    pagesFetched: number;
  }
  | { status: "unavailable"; reason: string }
  | { status: "not-requested" };

/** Bounded REST pagination and supported work-item filters. */
export interface GitLabListArguments {
  project: string;
  type: "all" | "issue" | "task" | "incident";
  state: "all" | "opened" | "closed";
  page: number;
  perPage: number;
  maxPages: number;
}

/** Full description plus optional bounded parent/child retrieval. */
export interface GitLabGetArguments {
  project: string;
  iid: number;
  includeHierarchy: boolean;
  perPage: number;
  maxPages: number;
  after?: string;
}

/** List data and whether further REST pages remain. */
export interface GitLabListResult {
  project: string;
  items: GitLabWorkItem[];
  pagination: {
    complete: boolean;
    nextPage: number | null;
    pagesFetched: number;
  };
}

/** Work-item detail with explicit hierarchy availability. */
export interface GitLabGetResult {
  project: string;
  item: GitLabWorkItem;
  hierarchy: GitLabHierarchy;
}

const hierarchyQuery = `query WorkItemHierarchy(
  $project: ID!, $iid: String!, $first: Int!, $after: String
) {
  project(fullPath: $project) {
    workItems(iid: $iid, first: 1) {
      nodes {
        id iid title webUrl
        widgets(onlyTypes: [HIERARCHY]) {
          type
          ... on WorkItemWidgetHierarchy {
            parent { id iid title webUrl }
            children(first: $first, after: $after) {
              nodes { id iid title webUrl }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  }
}`;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitLab returned an invalid object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitLab returned an invalid string.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1
  ) {
    throw new Error("Expected a safe positive integer.");
  }
  return number;
}

function boundedInteger(value: number, maximum: number): number {
  const result = positiveInteger(value);
  if (result > maximum) throw new Error("Pagination limit is out of range.");
  return result;
}

function projectPath(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error("A GitLab project path is required.");
  }
  return value;
}

function workItem(value: unknown): GitLabWorkItem {
  const item = record(value);
  if (
    !Array.isArray(item.labels) ||
    !item.labels.every((v) => typeof v === "string")
  ) {
    throw new Error("GitLab returned invalid labels.");
  }
  const type = string(item.issue_type);
  if (!type) throw new Error("GitLab did not return a work-item type.");
  return {
    id: positiveInteger(item.id),
    iid: positiveInteger(item.iid),
    type,
    title: string(item.title),
    description: item.description === null ? "" : string(item.description),
    state: string(item.state),
    webUrl: string(item.web_url),
    labels: item.labels as string[],
    createdAt: string(item.created_at),
    updatedAt: string(item.updated_at),
  };
}

function reference(value: unknown): GitLabWorkItemReference {
  const item = record(value);
  const gid = string(item.id);
  const match = /^gid:\/\/gitlab\/WorkItem\/([1-9][0-9]*)$/.exec(gid);
  if (!match) {
    throw new Error("GitLab returned an invalid work-item global ID.");
  }
  return {
    id: positiveInteger(match[1]),
    gid,
    iid: positiveInteger(item.iid),
    title: string(item.title),
    webUrl: string(item.webUrl),
  };
}

/** Read-only client. Requests stay on the configured HTTPS host and never follow redirects. */
export class GitLabWorkItemsClient {
  private readonly origin: string;
  private readonly token: string;

  /** Accept a hostname with an optional port, and a token with GitLab API read access. */
  constructor(host: string, token: string) {
    if (
      typeof host !== "string" || !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)
    ) {
      throw new Error(
        "GitLab host must be a hostname with an optional HTTPS port.",
      );
    }
    try {
      const url = new URL(`https://${host}`);
      if (
        !url.hostname.split(".").every((part) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part)
        )
      ) {
        throw new Error();
      }
      this.origin = url.origin;
    } catch {
      throw new Error(
        "GitLab host must be a hostname with an optional HTTPS port.",
      );
    }
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
      throw new Error("A valid GitLab token is required.");
    }
    this.token = token;
  }

  private async request(
    url: URL,
    body?: Record<string, unknown>,
  ): Promise<{ response: Response; data: unknown }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error("GitLab request failed or timed out.");
    }
    if (!response.ok) {
      // Cleanup must not replace the safe HTTP error with transport details.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitLab request failed (HTTP ${response.status}).`);
    }
    try {
      return { response, data: await response.json() };
    } catch {
      throw new Error("GitLab returned invalid JSON.");
    }
  }

  /** Read successive issue, task or incident pages up to the explicit request limit. */
  async list(args: GitLabListArguments): Promise<GitLabListResult> {
    const project = projectPath(args.project);
    let page = positiveInteger(args.page);
    const perPage = boundedInteger(args.perPage, 100);
    const maxPages = boundedInteger(args.maxPages, 100);
    if (
      !["all", "issue", "task", "incident"].includes(args.type) ||
      !["all", "opened", "closed"].includes(args.state)
    ) {
      throw new Error("Unsupported GitLab work-item filter.");
    }
    const items: GitLabWorkItem[] = [];
    const seen = new Set<number>();
    for (let pagesFetched = 1; pagesFetched <= maxPages; pagesFetched++) {
      const url = new URL(
        `/api/v4/projects/${encodeURIComponent(project)}/issues`,
        this.origin,
      );
      url.search = new URLSearchParams({
        scope: "all",
        state: args.state,
        page: String(page),
        per_page: String(perPage),
        order_by: "created_at",
        sort: "asc",
        ...(args.type === "all" ? {} : { issue_type: args.type }),
      }).toString();
      const { response, data } = await this.request(url);
      if (!Array.isArray(data) || data.length > perPage) {
        throw new Error("GitLab returned an invalid work-item page.");
      }
      for (const raw of data) {
        const item = workItem(raw);
        if (seen.has(item.id)) {
          throw new Error("GitLab repeated a work item while paginating.");
        }
        if (args.type !== "all" && item.type !== args.type) {
          throw new Error(
            "GitLab returned a work item outside the requested type.",
          );
        }
        seen.add(item.id);
        items.push(item);
      }
      const header = response.headers.get("x-next-page");
      if (header === null && data.length === perPage) {
        throw new Error("GitLab omitted pagination metadata for a full page.");
      }
      const nextPage = header === null || header === ""
        ? null
        : positiveInteger(header);
      if (nextPage !== null && (nextPage !== page + 1 || data.length === 0)) {
        throw new Error("GitLab returned invalid page progression.");
      }
      if (nextPage === null || pagesFetched === maxPages) {
        return {
          project,
          items,
          pagination: { complete: nextPage === null, nextPage, pagesFetched },
        };
      }
      page = nextPage;
    }
    throw new Error("GitLab pagination did not complete.");
  }

  /** Read a full work-item description and, when requested, its hierarchy. */
  async get(args: GitLabGetArguments): Promise<GitLabGetResult> {
    const project = projectPath(args.project);
    const iid = positiveInteger(args.iid);
    const perPage = boundedInteger(args.perPage, 100);
    const maxPages = boundedInteger(args.maxPages, 100);
    if (typeof args.includeHierarchy !== "boolean") {
      throw new Error("includeHierarchy must be a boolean.");
    }
    if (
      args.after !== undefined &&
      (typeof args.after !== "string" || !args.after)
    ) {
      throw new Error("Hierarchy cursor must be a non-empty string.");
    }
    const url = new URL(
      `/api/v4/projects/${encodeURIComponent(project)}/issues/${iid}`,
      this.origin,
    );
    const { data } = await this.request(url);
    const item = workItem(data);
    if (item.iid !== iid) {
      throw new Error("GitLab returned a different work item.");
    }
    const hierarchy = args.includeHierarchy
      ? await this.getHierarchy(project, item, perPage, maxPages, args.after)
      : { status: "not-requested" } as const;
    return { project, item, hierarchy };
  }

  private async getHierarchy(
    project: string,
    item: GitLabWorkItem,
    first: number,
    maxPages: number,
    initialCursor?: string,
  ): Promise<GitLabHierarchy> {
    let after: string | null = initialCursor ?? null;
    let parent: GitLabWorkItemReference | null = null;
    let priorParentId: number | null | undefined;
    const children: GitLabWorkItemReference[] = [];
    const seenChildren = new Set<number>();
    const seenCursors = new Set<string>(initialCursor ? [initialCursor] : []);
    for (let pagesFetched = 1; pagesFetched <= maxPages; pagesFetched++) {
      const { data } = await this.request(
        new URL("/api/graphql", this.origin),
        {
          query: hierarchyQuery,
          variables: { project, iid: String(item.iid), first, after },
        },
      );
      const envelope = record(data);
      if (
        envelope.errors !== undefined &&
        (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
      ) {
        throw new Error(
          "GitLab GraphQL returned errors; hierarchy is incomplete.",
        );
      }
      const connection = record(
        record(record(envelope.data).project).workItems,
      );
      if (!Array.isArray(connection.nodes) || connection.nodes.length !== 1) {
        throw new Error("GitLab did not return the requested hierarchy root.");
      }
      const root = record(connection.nodes[0]);
      const rootReference = reference(root);
      if (rootReference.iid !== item.iid || rootReference.id !== item.id) {
        throw new Error("GitLab returned a different hierarchy root.");
      }
      if (root.widgets === null || root.widgets === undefined) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the hierarchy widget.",
        };
      }
      if (!Array.isArray(root.widgets)) {
        throw new Error("GitLab returned invalid work-item widgets.");
      }
      const widgets = root.widgets.map(record).filter((widget) =>
        widget.type === "HIERARCHY"
      );
      if (widgets.length === 0) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the hierarchy widget.",
        };
      }
      if (widgets.length !== 1) {
        throw new Error("GitLab returned duplicate hierarchy widgets.");
      }
      const widget = widgets[0];
      if (
        !("parent" in widget) || widget.children === null ||
        widget.children === undefined
      ) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the complete hierarchy widget.",
        };
      }
      const currentParent = widget.parent === null
        ? null
        : reference(widget.parent);
      if (pagesFetched > 1 && (currentParent?.id ?? null) !== priorParentId) {
        throw new Error("GitLab hierarchy changed while paginating.");
      }
      parent = currentParent;
      priorParentId = currentParent?.id ?? null;
      const childConnection = record(widget.children);
      if (
        !Array.isArray(childConnection.nodes) ||
        childConnection.nodes.length > first
      ) {
        throw new Error("GitLab returned an invalid hierarchy page.");
      }
      for (const node of childConnection.nodes) {
        const child = reference(node);
        if (seenChildren.has(child.id)) {
          throw new Error("GitLab repeated a child while paginating.");
        }
        seenChildren.add(child.id);
        children.push(child);
      }
      const pageInfo = record(childConnection.pageInfo);
      if (
        typeof pageInfo.hasNextPage !== "boolean" ||
        (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
      ) {
        throw new Error(
          "GitLab returned invalid hierarchy pagination metadata.",
        );
      }
      const nextCursor = pageInfo.hasNextPage
        ? pageInfo.endCursor as string
        : null;
      if (
        pageInfo.hasNextPage &&
        (!nextCursor || seenCursors.has(nextCursor) ||
          childConnection.nodes.length === 0)
      ) {
        throw new Error(
          "GitLab returned invalid hierarchy cursor progression.",
        );
      }
      if (!pageInfo.hasNextPage || pagesFetched === maxPages) {
        return {
          status: "available",
          parent,
          children,
          complete: !pageInfo.hasNextPage,
          nextCursor,
          pagesFetched,
        };
      }
      seenCursors.add(nextCursor!);
      after = nextCursor;
    }
    throw new Error("GitLab hierarchy pagination did not complete.");
  }
}
