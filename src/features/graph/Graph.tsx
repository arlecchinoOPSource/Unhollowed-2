import { invoke } from "@tauri-apps/api/core";
import cytoscape, { type Core } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { loadLibrary } from "../../database/documentLibrary";
import { documentHref } from "../documents/editor/DocumentReferences";
import { listProjects } from "../../database/projects";
import "./graph.css";

interface GraphData {
  documents: { id: string; title: string; folderId: string | null }[];
  links: { source: string; target: string }[];
  memberships: [documentId: string, projectId: string][];
}

function neighborhood(data: GraphData, center: string, depth: number) {
  const adjacent = new Map<string, string[]>();
  for (const { source, target } of data.links) {
    const outgoing = adjacent.get(source) ?? [];
    const incoming = adjacent.get(target) ?? [];
    outgoing.push(target);
    incoming.push(source);
    adjacent.set(source, outgoing);
    adjacent.set(target, incoming);
  }
  const reached = new Set([center]);
  let frontier = [center];
  for (let step = 0; step < depth; step++) {
    const next = [];
    for (const id of frontier) {
      for (const neighbor of adjacent.get(id) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return reached;
}

export default function Graph() {
  const [params] = useSearchParams();
  const center = params.get("doc");
  const [data, setData] = useState<GraphData>();
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState("");
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [showOrphans, setShowOrphans] = useState(false);
  const [depth, setDepth] = useState(1);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    let active = true;
    invoke<GraphData>("get_document_graph")
      .then((value) => active && setData(value))
      .catch(() => active && setFailure(true));
    listProjects()
      .then((items) => active && setProjects(items))
      .catch(() => undefined);
    loadLibrary()
      .then((library) => active && setFolders(library.folders))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    if (!data) return undefined;
    const nearby = center ? neighborhood(data, center, depth) : null;
    const members = project
      ? new Set(
          data.memberships.filter(([, id]) => id === project).map(([id]) => id),
        )
      : null;
    const documents = data.documents.filter((item) =>
      nearby
        ? nearby.has(item.id)
        : (!folder || folder === item.folderId) &&
          (!members || members.has(item.id)),
    );
    const ids = new Set(documents.map(({ id }) => id));
    const links = data.links.filter(
      ({ source, target }) => ids.has(source) && ids.has(target),
    );
    const connected = new Set(
      links.flatMap(({ source, target }) => [source, target]),
    );
    return {
      documents:
        center || showOrphans
          ? documents
          : documents.filter(({ id }) => connected.has(id)),
      links,
    };
  }, [center, data, depth, folder, project, showOrphans]);

  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Core>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!host.current || !visible?.documents.length) return;
    const root = document.documentElement;
    const graph = cytoscape({
      container: host.current,
      elements: [
        ...visible.documents.map(({ id, title }) => ({
          data: { id, title },
          classes: id === center ? "center" : "",
        })),
        ...visible.links.map(({ source, target }) => ({
          data: { source, target },
        })),
      ],
      layout: { name: "circle", padding: 70 },
      minZoom: 0.04,
      maxZoom: 3,
      boxSelectionEnabled: false,
      motionBlur: false,
    });
    function applyTheme() {
      const theme = getComputedStyle(root);
      graph
        .style([
          {
            selector: "node",
            style: {
              label: "data(title)",
              "font-size": 12,
              width: 18,
              height: 18,
              "background-color": theme.getPropertyValue("--accent").trim(),
              color: theme.getPropertyValue("--text").trim(),
              "text-background-color": theme
                .getPropertyValue("--surface")
                .trim(),
              "text-background-opacity": 1,
              "text-background-padding": "3px",
              "text-wrap": "ellipsis",
              "text-max-width": "108px",
              "text-margin-y": -5,
            },
          },
          { selector: "node.center", style: { width: 28, height: 28 } },
          {
            selector: "node.hovered",
            style: {
              "border-width": 3,
              "border-color": theme.getPropertyValue("--text").trim(),
            },
          },
          {
            selector: "edge",
            style: {
              width: 1,
              "curve-style": "bezier",
              "target-arrow-shape": "triangle",
              "line-color": theme.getPropertyValue("--control-line").trim(),
              "target-arrow-color": theme
                .getPropertyValue("--control-line")
                .trim(),
            },
          },
          { selector: ".dimmed", style: { opacity: 0.24 } },
        ])
        .update();
    }
    applyTheme();
    graph.on(
      "tap",
      "node",
      (event) => void navigate(documentHref(event.target.id())),
    );
    graph.on("mouseover", "node", (event) => event.target.addClass("hovered"));
    graph.on("mouseout", "node", (event) =>
      event.target.removeClass("hovered"),
    );
    const theme = new MutationObserver(applyTheme);
    theme.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    instance.current = graph;
    return () => {
      theme.disconnect();
      instance.current = null;
      graph.destroy();
    };
  }, [center, navigate, visible]);
  const search = query.trim().toLowerCase();
  useEffect(() => {
    instance.current?.nodes().forEach((node) => {
      node.toggleClass(
        "dimmed",
        Boolean(search) &&
          !String(node.data("title")).toLowerCase().includes(search),
      );
    });
  }, [search, visible]);

  const centerTitle = data?.documents.find(({ id }) => id === center)?.title;
  return (
    <>
      <h1>{centerTitle ? `Graph · ${centerTitle}` : "Knowledge graph"}</h1>
      <div className="graph-tools">
        {center ? (
          <>
            <Link to="/graph">Workspace graph</Link>
            <label>
              Relationship depth{" "}
              <select
                value={depth}
                onChange={(event) => setDepth(Number(event.target.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Folder{" "}
              <select
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              >
                <option value="">All folders</option>
                {folders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project{" "}
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={showOrphans}
                onChange={(event) => setShowOrphans(event.target.checked)}
              />{" "}
              Show unlinked documents
            </label>
          </>
        )}
        <label>
          Find a document{" "}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!visible?.documents.length}
          onClick={() => instance.current?.fit(undefined, 60)}
        >
          Fit graph
        </button>
      </div>
      {failure && <p role="alert">Could not load the knowledge graph.</p>}
      {!data && !failure && <p role="status">Loading graph…</p>}
      {visible && !visible.documents.length && (
        <p>
          {center
            ? "This document is unavailable in the graph."
            : "No documents match the graph filters."}
        </p>
      )}
      <div
        ref={host}
        className="graph-canvas"
        hidden={!visible?.documents.length}
        aria-hidden="true"
      />
      {Boolean(visible?.documents.length) && (
        <details open={search ? true : undefined}>
          <summary>Documents in graph</summary>
          <ul>
            {visible?.documents
              .filter(({ title }) => title.toLowerCase().includes(search))
              .map(({ id, title }) => (
                <li key={id}>
                  <Link to={documentHref(id)}>{title}</Link>
                </li>
              ))}
          </ul>
        </details>
      )}
    </>
  );
}
