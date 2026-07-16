"use client";

import { useState } from "react";
import { Badge, Button, Icon } from "@/components";
import {
  IntegrationGlyph,
  SliderRow,
  SpecCell,
  Td,
  TextIn,
  Th,
} from "../atoms";
import { ModalOverlay } from "./ModalOverlay";
import { PROVIDER_MODEL_CATALOG } from "../data";

export function AddModelModal({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<keyof typeof PROVIDER_MODEL_CATALOG>(
    "anthropic",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [role, setRole] = useState<"primary" | "fallback" | "shadow">(
    "primary",
  );
  const [cap, setCap] = useState(30);
  const [maxOut, setMaxOut] = useState(2048);
  const [temp, setTemp] = useState(0.2);
  const [pinAlias, setPinAlias] = useState("");

  const list = PROVIDER_MODEL_CATALOG[provider] ?? [];
  const sel = list.find((m) => m.name === selected) ?? null;

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 960,
          maxHeight: "86vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icon name="plus" size={14} style={{ color: "var(--signal)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                color: "var(--text)",
                fontWeight: 500,
              }}
            >
              Add model to fleet
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              Pick from a connected provider&apos;s catalog. Agents can then
              pin or fall through to it.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              color: "var(--text-3)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr 280px",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Provider rail */}
          <div
            style={{
              borderRight: "1px solid var(--border)",
              overflow: "auto",
              padding: "10px 0",
              background: "var(--bg-2)",
            }}
          >
            <div
              style={{
                padding: "0 14px 6px 14px",
                fontSize: 10,
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                color: "var(--text-3)",
                letterSpacing: "0.08em",
              }}
            >
              Providers
            </div>
            {(Object.keys(PROVIDER_MODEL_CATALOG) as Array<
              keyof typeof PROVIDER_MODEL_CATALOG
            >).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setProvider(p);
                  setSelected(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 14px",
                  background:
                    provider === p ? "var(--panel-2)" : "transparent",
                  borderLeft: `2px solid ${
                    provider === p ? "var(--signal)" : "transparent"
                  }`,
                  textAlign: "left",
                  fontSize: 12.5,
                  color: provider === p ? "var(--text)" : "var(--text-2)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                <IntegrationGlyph id={p.toLowerCase()} />
                <div style={{ flex: 1 }}>
                  <div>{p}</div>
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: "var(--mono)",
                      color: "var(--text-3)",
                    }}
                  >
                    {(PROVIDER_MODEL_CATALOG[p] ?? []).length} models
                  </div>
                </div>
              </button>
            ))}
            <button
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 14px",
                fontSize: 12,
                color: "var(--text-3)",
                borderTop: "1px solid var(--border)",
                marginTop: 6,
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <Icon name="plus" size={11} /> Connect another
            </button>
          </div>

          {/* Catalog */}
          <div style={{ overflow: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: "var(--panel-2)",
                  }}
                >
                  <Th>Model</Th>
                  <Th>Context</Th>
                  <Th>$ / 1M in</Th>
                  <Th>$ / 1M out</Th>
                  <Th>Caps</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => {
                  const isSel = selected === m.name;
                  return (
                    <tr
                      key={m.name}
                      onClick={() => !m.added && setSelected(m.name)}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        background: isSel
                          ? "var(--panel-2)"
                          : "transparent",
                        opacity: m.added ? 0.5 : 1,
                        cursor: m.added ? "not-allowed" : "pointer",
                      }}
                    >
                      <Td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <input
                            type="radio"
                            readOnly
                            checked={isSel}
                            disabled={m.added}
                            style={{ accentColor: "var(--signal)" }}
                          />
                          <div>
                            <div
                              className="mono"
                              style={{ color: "var(--text)" }}
                            >
                              {m.name}
                            </div>
                            {m.added && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-3)",
                                }}
                              >
                                already in fleet
                              </div>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <span
                          className="mono"
                          style={{ color: "var(--text-2)" }}
                        >
                          {(m.ctx / 1000).toFixed(0)}k
                        </span>
                      </Td>
                      <Td>
                        <span
                          className="mono"
                          style={{ color: "var(--text-2)" }}
                        >
                          ${m.inP}
                        </span>
                      </Td>
                      <Td>
                        <span
                          className="mono"
                          style={{ color: "var(--text-2)" }}
                        >
                          ${m.outP}
                        </span>
                      </Td>
                      <Td>
                        <div style={{ display: "flex", gap: 3 }}>
                          {m.vision && <Badge tone="muted">vision</Badge>}
                          {m.tools && <Badge tone="muted">tools</Badge>}
                          {m.reasoning && (
                            <Badge tone="signal">reasoning</Badge>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Detail / config */}
          <div
            style={{
              borderLeft: "1px solid var(--border)",
              background: "var(--bg-2)",
              overflow: "auto",
            }}
          >
            {sel ? (
              <div
                style={{
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                      textTransform: "uppercase",
                      color: "var(--text-3)",
                      letterSpacing: "0.08em",
                    }}
                  >
                    Adding
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 14,
                      color: "var(--text)",
                      marginTop: 2,
                    }}
                  >
                    {sel.name}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 6,
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                  }}
                >
                  <SpecCell label="Context" value={`${(sel.ctx / 1000).toFixed(0)}k`} />
                  <SpecCell
                    label="Max out"
                    value={sel.out == null ? "Not published" : `${(sel.out / 1000).toFixed(0)}k`}
                  />
                  <SpecCell label="$ / 1M in"  value={`$${sel.inP}`} />
                  <SpecCell label="$ / 1M out" value={`$${sel.outP}`} />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    Role
                  </label>
                  <div
                    style={{
                      display: "flex",
                      gap: 0,
                      border: "1px solid var(--border-2)",
                      borderRadius: 5,
                      overflow: "hidden",
                    }}
                  >
                    {(["primary", "fallback", "shadow"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => setRole(r)}
                        style={{
                          flex: 1,
                          padding: "5px 0",
                          background:
                            role === r ? "var(--panel-3)" : "var(--panel-2)",
                          color: role === r ? "var(--text)" : "var(--text-3)",
                          fontSize: 10.5,
                          fontFamily: "var(--mono)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          borderRight: "1px solid var(--border-2)",
                          borderBottom:
                            role === r
                              ? "2px solid var(--signal)"
                              : "2px solid transparent",
                          cursor: "pointer",
                        }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    Internal alias{" "}
                    <span style={{ color: "var(--text-4)" }}>(optional)</span>
                  </label>
                  <TextIn
                    value={pinAlias}
                    onChange={setPinAlias}
                    mono
                    placeholder={sel.name.replace(/.*-/, "fast-")}
                  />
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 10.5,
                      color: "var(--text-3)",
                    }}
                  >
                    Agents pin alias names; you can swap the underlying model
                    later.
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    Daily cap
                  </label>
                  <TextIn
                    value={String(cap)}
                    onChange={(v) => setCap(parseFloat(v) || 0)}
                    mono
                    prefix="$"
                    suffix="/ day"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    Max output tokens
                  </label>
                  <TextIn
                    value={String(maxOut)}
                    onChange={(v) => setMaxOut(parseInt(v) || 0)}
                    mono
                    suffix="tokens"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    Temperature
                  </label>
                  <SliderRow
                    value={temp}
                    onChange={setTemp}
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </div>
              </div>
            ) : (
              <div
                style={{
                  padding: "32px 20px",
                  textAlign: "center",
                  color: "var(--text-3)",
                  fontSize: 12,
                }}
              >
                <Icon
                  name="spark"
                  size={20}
                  style={{ color: "var(--text-4)" }}
                />
                <div style={{ marginTop: 8 }}>
                  Pick a model from the catalog
                </div>
              </div>
            )}
          </div>
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {sel ? (
              <>
                Will appear as{" "}
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  {pinAlias || sel.name}
                </span>{" "}
                in the model fleet.
              </>
            ) : (
              "Nothing selected."
            )}
          </span>
          <div
            style={{ marginLeft: "auto", display: "flex", gap: 6 }}
          >
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" icon="check" onClick={onClose}>
              Add to fleet
            </Button>
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}
