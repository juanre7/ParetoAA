(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const STORAGE_KEY = "aa-pareto-overlay-config";
  const OVERLAY_SELECTOR = "[data-aa-pareto-overlay]";
  const TABLE_SELECTOR = "[data-aa-pareto-table]";
  const DEFAULT_CONFIG = {
    enabled: true,
    xMode: "auto",
    yMode: "auto",
    dimDominated: true,
    showTable: true
  };

  let config = loadConfig();
  let scheduledFrame = 0;
  let lastStats = { charts: 0, points: 0, frontier: 0 };
  let statusNode = null;
  let controlsShadow = null;
  let chartIdCounter = 0;

  function loadConfig() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function scheduleUpdate() {
    if (scheduledFrame) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = 0;
      updateAllCharts();
    });
  }

  function updateAllCharts() {
    const svgs = getChartSvgs();
    const stats = { charts: 0, points: 0, frontier: 0 };
    const liveChartIds = new Set(svgs.map((svg) => getChartId(svg)));

    document.querySelectorAll(TABLE_SELECTOR).forEach((table) => {
      if (!config.enabled || !liveChartIds.has(table.dataset.aaParetoChartId)) {
        table.remove();
      }
    });

    for (const svg of svgs) {
      if (!config.enabled) {
        clearOverlay(svg);
        clearParetoTable(svg);
        restoreAllPointStyles(svg);
        continue;
      }

      const chartStats = updateChart(svg);
      if (chartStats.points > 0) {
        stats.charts += 1;
        stats.points += chartStats.points;
        stats.frontier += chartStats.frontier;
      }
    }

    lastStats = stats;
    renderStatus();
  }

  function getChartSvgs() {
    return [...new Set([...document.querySelectorAll("svg.recharts-surface"), ...document.querySelectorAll("svg")])]
      .filter((svg) => !svg.closest(OVERLAY_SELECTOR))
      .filter(isSupportedChartSvg);
  }

  function isSupportedChartSvg(svg) {
    if (svg.classList.contains("recharts-surface")) return true;

    const viewBox = getSvgViewBox(svg);
    const width = readNumber(svg, "width") || svg.getBoundingClientRect().width || viewBox.width || 0;
    const height = readNumber(svg, "height") || svg.getBoundingClientRect().height || viewBox.height || 0;
    if (width < 240 || height < 180) return false;

    return getGenericScatterCircles(svg).length >= 3 && hasAxisLikeText(svg);
  }

  function hasAxisLikeText(svg) {
    const text = normalizeText(svg.textContent);
    return (
      /(score|index|quality|accuracy|benchmark|elo|intelligence|reasoning|coding)/i.test(text) &&
      /(parameters?|params?|model size|price|cost|latency|speed|context|tokens?|date)/i.test(text)
    );
  }

  function updateChart(svg) {
    const plot = getPlotArea(svg);
    const points = getScatterPoints(svg, plot);

    clearOverlay(svg);

    if (points.length < 3) {
      clearParetoTable(svg);
      restorePointStyles(points);
      return { points: points.length, frontier: 0 };
    }

    const labels = getAxisLabels(svg);
    const xDirection = resolveDirection("x", labels.x, config.xMode);
    const yDirection = resolveDirection("y", labels.y, config.yMode);
    const groups = groupPoints(points);
    const frontier = getParetoFrontier(groups, xDirection, yDirection);

    applyPointStyles(points, frontier);
    drawOverlay(svg, plot, frontier, {
      points: points.length,
      xDirection,
      yDirection
    });
    renderParetoTable(svg, plot, frontier, labels, { xDirection, yDirection });

    return { points: points.length, frontier: frontier.length };
  }

  function getPlotArea(svg) {
    const rects = [...svg.querySelectorAll("clipPath rect")]
      .map((rect) => ({
        x: readNumber(rect, "x"),
        y: readNumber(rect, "y"),
        width: readNumber(rect, "width"),
        height: readNumber(rect, "height")
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => b.width * b.height - a.width * a.height);

    if (rects[0]) return rects[0];

    const viewBox = getSvgViewBox(svg);
    const width = readNumber(svg, "width") || viewBox.width || 0;
    const height = readNumber(svg, "height") || viewBox.height || 0;
    return { x: 0, y: 0, width, height };
  }

  function getSvgViewBox(svg) {
    const viewBox = svg.viewBox?.baseVal;
    return {
      width: viewBox?.width || 0,
      height: viewBox?.height || 0
    };
  }

  function getScatterPoints(svg, plot) {
    const circles = [
      ...new Set([
        ...svg.querySelectorAll("g.recharts-scatter-symbol circle"),
        ...svg.querySelectorAll("circle.recharts-dot")
      ])
    ];
    const pointCircles = circles.length > 0 ? circles : getGenericScatterCircles(svg);

    return pointCircles
      .filter((circle) => !circle.closest(OVERLAY_SELECTOR))
      .map((circle) => {
        const center = getCircleCenterInSvg(svg, circle);
        return {
          el: circle,
          x: center.x,
          y: center.y,
          r: readNumber(circle, "r") || 0
        };
      })
      .filter((point) => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
        if (point.r < 2) return false;
        return isInsidePlot(point, plot, 2);
      });
  }

  function getGenericScatterCircles(svg) {
    return [...svg.querySelectorAll("circle")].filter((circle) => {
      if (circle.closest(OVERLAY_SELECTOR)) return false;
      const r = readNumber(circle, "r");
      if (r < 2 || r > 18) return false;

      const fill = (circle.getAttribute("fill") || "").trim().toLowerCase();
      const stroke = (circle.getAttribute("stroke") || "").trim().toLowerCase();
      if (fill === "none" && stroke === "none") return false;
      if (fill === "transparent") return false;

      if (!circle.hasAttribute("cx") || !circle.hasAttribute("cy")) return false;
      return Number.isFinite(readNumber(circle, "cx")) && Number.isFinite(readNumber(circle, "cy"));
    });
  }

  function getCircleCenterInSvg(svg, circle) {
    const raw = {
      x: readNumber(circle, "cx"),
      y: readNumber(circle, "cy")
    };

    return pointInSvg(svg, circle, raw.x, raw.y);
  }

  function isInsidePlot(point, plot, tolerance) {
    return (
      point.x >= plot.x - tolerance &&
      point.x <= plot.x + plot.width + tolerance &&
      point.y >= plot.y - tolerance &&
      point.y <= plot.y + plot.height + tolerance
    );
  }

  function getAxisLabels(svg) {
    const labels = [...svg.querySelectorAll("text.recharts-label")].map((text) => ({
      text: normalizeText(text.textContent),
      rotated: /rotate\(/i.test(text.getAttribute("transform") || "")
    }));

    const rechartsLabels = {
      x: labels.find((label) => !label.rotated)?.text || "",
      y: labels.find((label) => label.rotated)?.text || ""
    };
    if (rechartsLabels.x || rechartsLabels.y) return rechartsLabels;

    return getFallbackAxisLabels(svg);
  }

  function getFallbackAxisLabels(svg) {
    const labels = [...svg.querySelectorAll("text")]
      .map((text) => ({
        text: normalizeText(text.textContent),
        rotated: /rotate\(\s*-?90/i.test(text.getAttribute("transform") || ""),
        hasLetters: /[a-z]/i.test(text.textContent || "")
      }))
      .filter((label) => label.hasLetters && label.text.length > 2);

    const x = labels.find((label) => !label.rotated && isLikelyAxisLabel("x", label.text))?.text || "";
    const y = labels.find((label) => label.rotated && isLikelyAxisLabel("y", label.text))?.text || "";

    return { x, y };
  }

  function isLikelyAxisLabel(axis, text) {
    if (axis === "y") {
      return /\b(score|index|quality|accuracy|benchmark|elo|win rate|intelligence|reasoning|coding)\b/i.test(text);
    }
    return /(cost|price|pricing|latency|delay|ttft|time|duration|parameters?|params?|model size|memory|tokens?\/\$|usd|\$|dollars?|\/1m|per\s+1m|speed|throughput|tokens?\/s|tps|context|window|release date|date)/i.test(text);
  }

  function resolveDirection(axis, label, mode) {
    if (mode === "low" || mode === "high") return mode;

    const lowerIsBetter =
      /(cost|price|pricing|latency|delay|ttft|time|duration|parameters?|params?|model size|memory|tokens?\/\$|usd|\$|dollars?|\/1m|per\s+1m)/i;
    const higherIsBetter =
      /\b(score|index|quality|accuracy|benchmark|elo|win rate|intelligence|reasoning|coding|speed|throughput|tokens?\/s|tps|context|window)\b/i;

    if (lowerIsBetter.test(label)) return "low";
    if (higherIsBetter.test(label)) return "high";

    return axis === "y" ? "high" : "low";
  }

  function groupPoints(points) {
    const groupsByPosition = new Map();

    for (const point of points) {
      const key = `${Math.round(point.x * 2) / 2}:${Math.round(point.y * 2) / 2}`;
      const group = groupsByPosition.get(key);
      if (group) {
        group.points.push(point);
        continue;
      }

      groupsByPosition.set(key, {
        x: point.x,
        y: point.y,
        points: [point]
      });
    }

    return [...groupsByPosition.values()];
  }

  function getParetoFrontier(groups, xDirection, yDirection) {
    const frontier = [];

    for (const candidate of groups) {
      const dominated = groups.some((other) => {
        if (other === candidate) return false;
        return (
          isBetterOrSame(other, candidate, "x", xDirection) &&
          isBetterOrSame(other, candidate, "y", yDirection) &&
          (isStrictlyBetter(other, candidate, "x", xDirection) ||
            isStrictlyBetter(other, candidate, "y", yDirection))
        );
      });

      if (!dominated) frontier.push(candidate);
    }

    return frontier.sort((a, b) => a.x - b.x || a.y - b.y);
  }

  function isBetterOrSame(a, b, axis, direction) {
    const tolerance = 0.5;
    const av = axis === "x" ? a.x : a.y;
    const bv = axis === "x" ? b.x : b.y;

    if (axis === "y" && direction === "high") return av <= bv + tolerance;
    if (axis === "y" && direction === "low") return av >= bv - tolerance;
    if (direction === "low") return av <= bv + tolerance;
    return av >= bv - tolerance;
  }

  function isStrictlyBetter(a, b, axis, direction) {
    const tolerance = 0.5;
    const av = axis === "x" ? a.x : a.y;
    const bv = axis === "x" ? b.x : b.y;

    if (axis === "y" && direction === "high") return av < bv - tolerance;
    if (axis === "y" && direction === "low") return av > bv + tolerance;
    if (direction === "low") return av < bv - tolerance;
    return av > bv + tolerance;
  }

  function drawOverlay(svg, plot, frontier, stats) {
    const group = svgEl("g", {
      "data-aa-pareto-overlay": "true",
      "pointer-events": "none"
    });

    if (frontier.length >= 2) {
      const path = buildStepPath(frontier);
      group.appendChild(
        svgEl("path", {
          d: path,
          fill: "none",
          stroke: "rgba(255,255,255,0.96)",
          "stroke-width": "8",
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        })
      );
      group.appendChild(
        svgEl("path", {
          d: path,
          fill: "none",
          stroke: "#f59e0b",
          "stroke-width": "3.5",
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        })
      );
    }

    for (const point of frontier) {
      group.appendChild(
        svgEl("circle", {
          cx: point.x,
          cy: point.y,
          r: "12",
          fill: "rgba(245,158,11,0.14)",
          stroke: "rgba(255,255,255,0.98)",
          "stroke-width": "7"
        })
      );
      group.appendChild(
        svgEl("circle", {
          cx: point.x,
          cy: point.y,
          r: "10",
          fill: "none",
          stroke: "#f59e0b",
          "stroke-width": "3"
        })
      );
    }

    drawBadge(group, plot, frontier.length, stats);
    svg.appendChild(group);
  }

  function buildStepPath(points) {
    const [first, ...rest] = points;
    const chunks = [`M ${round(first.x)} ${round(first.y)}`];
    let previous = first;

    for (const point of rest) {
      chunks.push(`L ${round(point.x)} ${round(previous.y)}`);
      chunks.push(`L ${round(point.x)} ${round(point.y)}`);
      previous = point;
    }

    return chunks.join(" ");
  }

  function drawBadge(group, plot, frontierCount, stats) {
    const xLabel = stats.xDirection === "low" ? "X low" : "X high";
    const yLabel = stats.yDirection === "low" ? "Y low" : "Y high";
    const label = `Pareto: ${frontierCount}/${stats.points} | ${xLabel} | ${yLabel}`;
    const x = plot.x + 8;
    const y = plot.y + 8;
    const width = Math.min(plot.width - 16, 7 * label.length + 16);

    group.appendChild(
      svgEl("rect", {
        x,
        y,
        width,
        height: "24",
        rx: "6",
        fill: "rgba(255,255,255,0.92)",
        stroke: "rgba(245,158,11,0.9)",
        "stroke-width": "1"
      })
    );
    const text = svgEl("text", {
      x: x + 8,
      y: y + 16,
      fill: "#111827",
      "font-size": "11",
      "font-family": "Inter, system-ui, sans-serif",
      "font-weight": "650"
    });
    text.textContent = label;
    group.appendChild(text);
  }

  function renderParetoTable(svg, plot, frontier, labels, directions) {
    clearParetoTable(svg);
    if (!config.showTable || frontier.length === 0) return;

    const anchor = getParetoTableAnchor(svg);
    if (!anchor.parentNode) return;

    const axisScales = getAxisScales(svg, plot, labels);
    const container = document.createElement("section");
    container.dataset.aaParetoTable = "true";
    container.dataset.aaParetoChartId = getChartId(svg);
    container.style.cssText = [
      "margin: 10px 0 18px",
      "border: 1px solid rgba(17, 24, 39, 0.12)",
      "border-radius: 8px",
      "background: rgba(255, 255, 255, 0.96)",
      "box-shadow: 0 6px 18px rgba(17, 24, 39, 0.08)",
      "overflow: hidden",
      "font: 12px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
      "color: #111827"
    ].join("; ");

    const header = document.createElement("div");
    header.style.cssText = [
      "display: flex",
      "align-items: center",
      "justify-content: space-between",
      "gap: 12px",
      "padding: 8px 10px",
      "background: rgba(245, 158, 11, 0.12)",
      "border-bottom: 1px solid rgba(17, 24, 39, 0.08)"
    ].join("; ");

    const title = document.createElement("strong");
    title.textContent = `Pareto selected points (${frontier.length})`;
    title.style.fontWeight = "700";
    header.appendChild(title);

    const note = document.createElement("span");
    note.textContent = "ordered by best Y";
    note.style.cssText = "color: #4b5563; font-size: 11px; white-space: nowrap";
    header.appendChild(note);
    container.appendChild(header);

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "overflow-x: auto";
    const table = document.createElement("table");
    table.style.cssText = "width: 100%; border-collapse: collapse; min-width: 520px";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    addHeaderCell(headerRow, "#");
    addHeaderCell(headerRow, "Model");
    addHeaderCell(headerRow, getAxisHeader("X", labels.x, axisScales.x));
    addHeaderCell(headerRow, getAxisHeader("Y", labels.y, axisScales.y));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const modelLabels = getModelLabels(svg);
    const attractiveRegions = getAttractiveRegions(svg, plot);
    const tablePoints = getTableOrderedPoints(frontier, axisScales, directions);
    tablePoints.forEach((point, index) => {
      const row = document.createElement("tr");
      row.style.borderTop = "1px solid rgba(17, 24, 39, 0.08)";
      if (isInsideAttractiveRegion(point, attractiveRegions)) {
        row.style.background = "rgba(144, 238, 144, 0.24)";
        row.style.boxShadow = "inset 3px 0 0 rgba(34, 197, 94, 0.5)";
      }
      const color = point.points[0]?.el.getAttribute("fill") || "#f59e0b";
      addBodyCell(row, String(index + 1), { color, rank: true });
      addBodyCell(row, getModelNameForPoint(point, modelLabels, index), { model: true });
      addBodyCell(row, formatAxisPosition(point.x, axisScales.x), { title: labels.x || "X" });
      addBodyCell(row, formatAxisPosition(point.y, axisScales.y), { title: labels.y || "Y" });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);

    anchor.insertAdjacentElement("afterend", container);
  }

  function getParetoTableAnchor(svg) {
    const rechartsAnchor = svg.closest(".recharts-responsive-container") || svg.closest(".recharts-wrapper");
    if (rechartsAnchor) return rechartsAnchor;

    return getScrollableChartContainer(svg) || svg;
  }

  function getScrollableChartContainer(svg) {
    const svgBounds = svg.getBoundingClientRect();
    let node = svg.parentElement;

    while (node && node !== document.body && node !== document.documentElement) {
      const classList = node.classList ? [...node.classList] : [];
      if (classList.includes("overflow-x-scroll") || classList.includes("overflow-x-auto")) {
        return node;
      }

      const bounds = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const containsChart =
        bounds.width >= svgBounds.width - 2 &&
        bounds.height >= svgBounds.height - 2 &&
        /auto|scroll/i.test(style.overflowX);
      if (containsChart) return node;

      node = node.parentElement;
    }

    return null;
  }

  function getTableOrderedPoints(frontier, axisScales, directions) {
    return [...frontier].sort((a, b) => {
      const yCompare = compareAxisPosition(a, b, axisScales.y, "y", directions.yDirection);
      if (yCompare !== 0) return yCompare;

      return compareAxisPosition(a, b, axisScales.x, "x", directions.xDirection);
    });
  }

  function compareAxisPosition(a, b, scale, axis, direction) {
    const aValue = getAxisSortValue(a, scale, axis);
    const bValue = getAxisSortValue(b, scale, axis);
    if (aValue === bValue) return 0;

    if (scale) return direction === "low" ? aValue - bValue : bValue - aValue;
    if (axis === "y") return direction === "low" ? bValue - aValue : aValue - bValue;
    return direction === "low" ? aValue - bValue : bValue - aValue;
  }

  function getAxisSortValue(point, scale, axis) {
    const pixel = axis === "x" ? point.x : point.y;
    return scale ? scale.toValue(pixel) : pixel;
  }

  function addHeaderCell(row, text) {
    const cell = document.createElement("th");
    cell.textContent = text;
    cell.style.cssText = [
      "padding: 7px 10px",
      "text-align: left",
      "font-weight: 700",
      "font-size: 11px",
      "color: #374151",
      "white-space: nowrap"
    ].join("; ");
    row.appendChild(cell);
  }

  function addBodyCell(row, text, options = {}) {
    const cell = document.createElement("td");
    cell.style.cssText = [
      "padding: 7px 10px",
      "white-space: nowrap",
      "font-variant-numeric: tabular-nums"
    ].join("; ");
    if (options.title) cell.title = options.title;
    if (options.model) {
      cell.style.whiteSpace = "normal";
      cell.style.minWidth = "180px";
      cell.style.fontVariantNumeric = "normal";
      cell.style.fontWeight = "600";
    }

    if (options.rank) {
      const marker = document.createElement("span");
      marker.style.cssText = [
        "display: inline-block",
        "width: 8px",
        "height: 8px",
        "margin-right: 7px",
        "border-radius: 50%",
        `background: ${options.color}`,
        "box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.22)"
      ].join("; ");
      cell.appendChild(marker);
    }

    cell.appendChild(document.createTextNode(text));
    row.appendChild(cell);
  }

  function getModelLabels(svg) {
    return [...svg.querySelectorAll("text")]
      .filter((text) => {
        if (text.closest(OVERLAY_SELECTOR)) return false;
        if (text.closest(".recharts-cartesian-axis-tick-labels")) return false;
        if (text.classList.contains("recharts-label")) return false;
        return normalizeText(text.textContent).length > 0;
      })
      .map((text) => {
        const parent = text.parentElement;
        const line = parent?.querySelector(":scope > line") || parent?.querySelector("line") || null;
        const endpoints = line
          ? [
              pointInSvg(svg, line, readNumber(line, "x1"), readNumber(line, "y1")),
              pointInSvg(svg, line, readNumber(line, "x2"), readNumber(line, "y2"))
            ]
          : [];

        return {
          name: normalizeText(text.textContent),
          textPoint: pointInSvg(svg, text, readNumber(text, "x"), readNumber(text, "y")),
          endpoints
        };
      })
      .filter((label) => label.name.length > 0);
  }

  function getModelNameForPoint(point, labels, index) {
    const endpointMatch = findClosestLabel(point, labels, "endpoints");
    if (endpointMatch && endpointMatch.distance <= 28) return endpointMatch.label.name;

    const textMatch = findClosestLabel(point, labels, "textPoint");
    if (textMatch && textMatch.distance <= 140) return textMatch.label.name;

    return `Unlabeled point ${index + 1}`;
  }

  function findClosestLabel(point, labels, mode) {
    let closest = null;

    for (const label of labels) {
      const candidates = mode === "endpoints" ? label.endpoints : [label.textPoint];
      for (const candidate of candidates) {
        if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
        const distance = distanceBetween(point, candidate);
        if (!closest || distance < closest.distance) {
          closest = { label, distance };
        }
      }
    }

    return closest;
  }

  function pointInSvg(svg, element, x, y) {
    const raw = { x, y };

    try {
      const elementMatrix = element.getScreenCTM();
      const svgMatrix = svg.getScreenCTM();
      if (!elementMatrix || !svgMatrix) return raw;

      let point = null;
      if (typeof DOMPoint === "function") {
        point = new DOMPoint(x, y);
      } else if (typeof svg.createSVGPoint === "function") {
        point = Object.assign(svg.createSVGPoint(), { x, y });
      } else {
        return elementCenterInSvg(svg, element);
      }

      return point
        .matrixTransform(elementMatrix)
        .matrixTransform(svgMatrix.inverse());
    } catch {
      return elementCenterInSvg(svg, element) || raw;
    }
  }

  function elementCenterInSvg(svg, element) {
    try {
      const svgBounds = svg.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      if (!svgBounds.width || !svgBounds.height || !bounds.width || !bounds.height) return null;

      return {
        x: bounds.left + bounds.width / 2 - svgBounds.left,
        y: bounds.top + bounds.height / 2 - svgBounds.top
      };
    } catch {
      return null;
    }
  }

  function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function getAttractiveRegions(svg, plot) {
    return [...svg.querySelectorAll("rect")]
      .filter((rect) => {
        if (rect.closest("defs")) return false;
        if (rect.closest(OVERLAY_SELECTOR)) return false;
        if (!isGreenishFill(rect)) return false;

        const width = readNumber(rect, "width");
        const height = readNumber(rect, "height");
        if (width * height < plot.width * plot.height * 0.05) return false;

        const region = getRectRegion(svg, rect);
        return Boolean(region && regionsOverlap(region, plot));
      })
      .map((rect) => getRectRegion(svg, rect))
      .filter(Boolean);
  }

  function getRectRegion(svg, rect) {
    const x = readNumber(rect, "x");
    const y = readNumber(rect, "y");
    const width = readNumber(rect, "width");
    const height = readNumber(rect, "height");
    if (width <= 0 || height <= 0) return null;

    const start = pointInSvg(svg, rect, x, y);
    const end = pointInSvg(svg, rect, x + width, y + height);

    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  }

  function regionsOverlap(a, b) {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  function isInsideAttractiveRegion(point, regions) {
    return regions.some((region) => isInsidePlot(point, region, 1));
  }

  function isGreenishFill(element) {
    const fill = (element.getAttribute("fill") || "").trim().toLowerCase();
    const opacity = Number.parseFloat(element.getAttribute("fill-opacity") || element.style.fillOpacity || "1");
    if (Number.isFinite(opacity) && opacity > 0.6) return false;

    if (fill === "lightgreen" || fill === "green" || fill === "#90ee90") return true;

    const rgb = fill.match(/rgba?\(([^)]+)\)/);
    if (!rgb) return false;

    const [r, g, b] = rgb[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Number.parseFloat(part.trim()));

    if (![r, g, b].every(Number.isFinite)) return false;
    return g >= 120 && g > r + 20 && g > b + 20;
  }

  function clearParetoTable(svg) {
    const chartId = getChartId(svg);
    document
      .querySelectorAll(`${TABLE_SELECTOR}[data-aa-pareto-chart-id="${chartId}"]`)
      .forEach((node) => node.remove());
  }

  function getChartId(svg) {
    if (!svg.dataset.aaParetoChartId) {
      chartIdCounter += 1;
      svg.dataset.aaParetoChartId = `chart-${chartIdCounter}`;
    }
    return svg.dataset.aaParetoChartId;
  }

  function getAxisScales(svg, plot, labels) {
    return {
      x: getAxisScale(svg, "x", plot, labels.x),
      y: getAxisScale(svg, "y", plot, labels.y)
    };
  }

  function getAxisScale(svg, axis, plot, label) {
    const ticks = getAxisTicks(svg, axis, label);

    if (ticks.length < 2) return null;

    const log = /log/i.test(label) && ticks.every((tick) => tick.value > 0);
    const fit = fitAxis(ticks, log);
    if (!fit) return null;

    return {
      axis,
      label,
      log,
      toValue(pixel) {
        const mapped = fit.slope * pixel + fit.intercept;
        return log ? 10 ** mapped : mapped;
      },
      domainPixelStart: axis === "x" ? plot.x : plot.y,
      domainPixelEnd: axis === "x" ? plot.x + plot.width : plot.y + plot.height
    };
  }

  function getAxisTicks(svg, axis, label) {
    const rechartsTicks = getRechartsAxisTicks(svg, axis, label);
    if (rechartsTicks.length >= 2) return rechartsTicks;

    return getGenericAxisTicks(svg, axis, label);
  }

  function getRechartsAxisTicks(svg, axis, label) {
    const selector = axis === "x" ? ".recharts-xAxis-tick-labels text" : ".recharts-yAxis-tick-labels text";
    return [...svg.querySelectorAll(selector)]
      .map((text) => {
        const value = parseTickValue(text.textContent, label);
        const pixel = axis === "x" ? readNumber(text, "x") : readNumber(text, "y");
        return { value, pixel };
      })
      .filter((tick) => Number.isFinite(tick.value) && Number.isFinite(tick.pixel));
  }

  function getGenericAxisTicks(svg, axis, label) {
    const viewBox = getSvgViewBox(svg);
    const width = readNumber(svg, "width") || viewBox.width || svg.getBoundingClientRect().width || 0;
    const height = readNumber(svg, "height") || viewBox.height || svg.getBoundingClientRect().height || 0;

    return [...svg.querySelectorAll("text")]
      .filter((text) => isNumericTickText(text.textContent))
      .map((text) => {
        const value = parseTickValue(text.textContent, label);
        const point = pointInSvg(svg, text, readNumber(text, "x"), readNumber(text, "y"));
        const pixel = axis === "x" ? point.x : point.y;
        return { value, pixel, point };
      })
      .filter((tick) => {
        if (!Number.isFinite(tick.value) || !Number.isFinite(tick.pixel)) return false;
        if (axis === "x") return tick.point.y >= height * 0.55 && tick.point.x >= width * 0.12 && tick.point.x <= width + 4;
        return tick.point.x <= width * 0.12 && tick.point.y >= -4 && tick.point.y <= height + 4;
      });
  }

  function isNumericTickText(text) {
    return /^[-+]?\d[\d,.]*(?:\.\d+)?\s*(?:[kmbt])?$/i.test(normalizeText(text));
  }

  function fitAxis(ticks, log) {
    const points = ticks.map((tick) => ({
      x: tick.pixel,
      y: log ? Math.log10(tick.value) : tick.value
    }));
    const n = points.length;
    const sumX = points.reduce((sum, point) => sum + point.x, 0);
    const sumY = points.reduce((sum, point) => sum + point.y, 0);
    const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
    const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
    const denominator = n * sumXX - sumX * sumX;

    if (Math.abs(denominator) < 1e-9) return null;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  }

  function parseTickValue(text, axisLabel) {
    const normalized = normalizeText(text).replace(/,/g, "");
    const match = normalized.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
    if (!match) return NaN;

    let value = Number.parseFloat(match[0]);
    const suffix = normalized.slice(match.index + match[0].length).trim().toLowerCase();

    if (suffix.startsWith("k")) value *= 1e3;
    if (suffix.startsWith("m")) {
      value = /billion|parameters?|params?/i.test(axisLabel) && value >= 10 ? value / 1000 : value * 1e6;
    }
    if (suffix.startsWith("b")) value *= 1e9;
    if (suffix.startsWith("t")) value *= 1e12;

    return value;
  }

  function getAxisHeader(axisName, label, scale) {
    const trimmed = label ? label.trim() : "";
    if (!scale) return `${axisName} px`;
    return trimmed ? `${axisName}: ${trimmed}` : axisName;
  }

  function formatAxisPosition(pixel, scale) {
    if (!scale) return formatPixel(pixel);
    return formatValue(scale.toValue(pixel));
  }

  function formatValue(value) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    const maximumFractionDigits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
    return value.toLocaleString(undefined, {
      maximumFractionDigits,
      minimumFractionDigits: 0
    });
  }

  function formatPixel(value) {
    return `${round(value)} px`;
  }

  function applyPointStyles(points, frontier) {
    const frontierElements = new Set(frontier.flatMap((group) => group.points.map((point) => point.el)));

    for (const point of points) {
      rememberPointStyle(point.el);
      if (!config.dimDominated) {
        restorePointStyle(point.el);
        continue;
      }

      if (frontierElements.has(point.el)) {
        point.el.style.opacity = "1";
        point.el.style.filter = "drop-shadow(0 0 3px rgba(245, 158, 11, 0.9))";
      } else {
        point.el.style.opacity = "0.22";
        point.el.style.filter = "grayscale(0.15)";
      }
    }
  }

  function restoreAllPointStyles(svg) {
    restorePointStyles(
      [
        ...new Set([
          ...svg.querySelectorAll("g.recharts-scatter-symbol circle"),
          ...svg.querySelectorAll("circle.recharts-dot"),
          ...getGenericScatterCircles(svg)
        ])
      ].map((el) => ({ el }))
    );
  }

  function restorePointStyles(points) {
    for (const point of points) restorePointStyle(point.el);
  }

  function rememberPointStyle(circle) {
    if (circle.dataset.aaParetoRemembered === "true") return;
    circle.dataset.aaParetoRemembered = "true";
    circle.dataset.aaParetoOpacity = circle.style.opacity || "";
    circle.dataset.aaParetoFilter = circle.style.filter || "";
  }

  function restorePointStyle(circle) {
    if (circle.dataset.aaParetoRemembered !== "true") return;
    circle.style.opacity = circle.dataset.aaParetoOpacity || "";
    circle.style.filter = circle.dataset.aaParetoFilter || "";
  }

  function clearOverlay(svg) {
    svg.querySelectorAll(OVERLAY_SELECTOR).forEach((node) => node.remove());
  }

  function createControls() {
    if (document.getElementById("aa-pareto-host")) return;

    const host = document.createElement("div");
    host.id = "aa-pareto-host";
    const shadow = host.attachShadow({ mode: "open" });
    controlsShadow = shadow;
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border: 1px solid rgba(17, 24, 39, 0.16);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.94);
          box-shadow: 0 10px 28px rgba(17, 24, 39, 0.16);
          color: #111827;
          font: 12px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          backdrop-filter: blur(8px);
        }
        button, select, label {
          font: inherit;
        }
        button {
          border: 1px solid rgba(245, 158, 11, 0.9);
          border-radius: 7px;
          background: #f59e0b;
          color: #111827;
          font-weight: 700;
          padding: 5px 8px;
          cursor: pointer;
        }
        button[aria-pressed="false"] {
          background: #f3f4f6;
          border-color: rgba(17, 24, 39, 0.18);
          color: #374151;
        }
        select {
          max-width: 88px;
          border: 1px solid rgba(17, 24, 39, 0.16);
          border-radius: 6px;
          background: white;
          color: #111827;
          padding: 4px 5px;
        }
        label {
          display: flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
          color: #374151;
        }
        .status {
          min-width: 82px;
          color: #4b5563;
          white-space: nowrap;
          text-align: right;
        }
      </style>
      <div class="panel" role="group" aria-label="Pareto overlay controls">
        <button type="button" id="toggle"></button>
        <select id="xMode" title="How to interpret the X axis">
          <option value="auto">X auto</option>
          <option value="low">X low</option>
          <option value="high">X high</option>
        </select>
        <select id="yMode" title="How to interpret the Y axis">
          <option value="auto">Y auto</option>
          <option value="low">Y low</option>
          <option value="high">Y high</option>
        </select>
        <label title="Dim dominated points">
          <input id="dimDominated" type="checkbox" />
          Dim
        </label>
        <label title="Show Pareto selected points table">
          <input id="showTable" type="checkbox" />
          Table
        </label>
        <span class="status" id="status"></span>
      </div>
    `;

    document.documentElement.appendChild(host);

    const toggle = shadow.getElementById("toggle");
    const xMode = shadow.getElementById("xMode");
    const yMode = shadow.getElementById("yMode");
    const dimDominated = shadow.getElementById("dimDominated");
    const showTable = shadow.getElementById("showTable");
    statusNode = shadow.getElementById("status");

    toggle.addEventListener("click", () => {
      config.enabled = !config.enabled;
      saveConfig();
      syncControls(shadow);
      scheduleUpdate();
    });
    xMode.addEventListener("change", () => {
      config.xMode = xMode.value;
      saveConfig();
      scheduleUpdate();
    });
    yMode.addEventListener("change", () => {
      config.yMode = yMode.value;
      saveConfig();
      scheduleUpdate();
    });
    dimDominated.addEventListener("change", () => {
      config.dimDominated = dimDominated.checked;
      saveConfig();
      scheduleUpdate();
    });
    showTable.addEventListener("change", () => {
      config.showTable = showTable.checked;
      saveConfig();
      scheduleUpdate();
    });

    syncControls(shadow);
  }

  function syncControls(shadow) {
    const toggle = shadow.getElementById("toggle");
    toggle.textContent = config.enabled ? "Pareto ON" : "Pareto OFF";
    toggle.setAttribute("aria-pressed", String(config.enabled));
    shadow.getElementById("xMode").value = config.xMode;
    shadow.getElementById("yMode").value = config.yMode;
    shadow.getElementById("dimDominated").checked = config.dimDominated;
    shadow.getElementById("showTable").checked = config.showTable;
    renderStatus();
  }

  function renderStatus() {
    if (!statusNode) return;
    if (!config.enabled) {
      statusNode.textContent = "disabled";
      return;
    }
    statusNode.textContent = `${lastStats.frontier}/${lastStats.points} pts`;
  }

  function observePage() {
    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.some((node) => !isOwnNode(node));
      });
      if (relevant) scheduleUpdate();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("hashchange", scheduleUpdate, { passive: true });
    setInterval(scheduleUpdate, 1500);
  }

  function isOwnNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const ownSelector = `#aa-pareto-host, ${OVERLAY_SELECTOR}, ${TABLE_SELECTOR}`;
    return Boolean(node.closest?.(ownSelector) || node.matches?.(ownSelector));
  }

  function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function readNumber(node, attr) {
    const value = Number.parseFloat(node.getAttribute(attr));
    return Number.isFinite(value) ? value : 0;
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  createControls();
  scheduleUpdate();
  observePage();

  window.AAParetoOverlay = {
    update: scheduleUpdate,
    getConfig: () => ({ ...config }),
    setConfig: (nextConfig) => {
      config = { ...config, ...nextConfig };
      saveConfig();
      if (controlsShadow) syncControls(controlsShadow);
      scheduleUpdate();
    }
  };
})();
