import { Hono } from "hono";
import { z } from "zod";
import { eq, and, asc, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { hashPin, weakPin } from "../lib/auth.ts";
import { PERMISSIONS, PERMISSION_GROUPS, ALL_PERMISSIONS, effectivePermissions } from "../lib/rbac.ts";
import { param, can, actor, notFound, bad, HttpError, type Env } from "../lib/http.ts";
import { toHinglish } from "../lib/translit.ts";

export const userRoutes = new Hono<Env>();

/** The permission catalogue, for rendering the roles matrix. */
userRoutes.get("/catalogue", can("users.read", "roles.manage"), (c) =>
  c.json({ permissions: PERMISSIONS, groups: PERMISSION_GROUPS }));

userRoutes.get("/", can("users.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const rows = await db.select({
    membershipId: schema.memberships.id,
    userId: schema.users.id,
    name: schema.users.name,
    nameHi: schema.users.nameHi,
    phone: schema.users.phone,
    isRoot: schema.users.isRoot,
    userActive: schema.users.active,
    membershipActive: schema.memberships.active,
    lockedUntil: schema.users.lockedUntil,
    roleId: schema.roles.id,
    roleKey: schema.roles.key,
    roleLabel: schema.roles.label,
    roleLabelHi: schema.roles.labelHi,
    createdAt: schema.users.createdAt,
  })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
    .where(eq(schema.memberships.businessId, biz))
    .orderBy(asc(schema.roles.rank), asc(schema.users.name));

  const ids = rows.map((r) => r.membershipId);
  const overrides = ids.length
    ? await db.select().from(schema.userPermissionOverrides)
        .where(inArray(schema.userPermissionOverrides.membershipId, ids))
    : [];
  const rolePerms = await db.select().from(schema.rolePermissions);
  const permsByRole = new Map<string, string[]>();
  for (const rp of rolePerms) {
    const list = permsByRole.get(rp.roleId) ?? [];
    list.push(rp.permission);
    permsByRole.set(rp.roleId, list);
  }

  return c.json(rows.map((r) => {
    const ovs = overrides.filter((o) => o.membershipId === r.membershipId);
    return {
      ...r,
      overrides: ovs.map((o) => ({ permission: o.permission, effect: o.effect })),
      effectivePermissions: [...effectivePermissions(permsByRole.get(r.roleId) ?? [], ovs)],
    };
  }));
});

userRoutes.post("/", can("users.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    name: z.string().trim().min(2),
    nameHi: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    pin: z.string(),
    roleId: z.string(),
  }).parse(await c.req.json());

  const weak = weakPin(body.pin);
  if (weak) throw bad(weak, "weak_pin");

  const [role] = await db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, body.roleId), eq(schema.roles.businessId, biz))).limit(1);
  if (!role) throw bad("Pick a valid role", "bad_role");

  const { hash, salt } = hashPin(body.pin);
  const userId = newId();
  await db.insert(schema.users).values({
    id: userId, name: body.name,
    nameHi: body.nameHi || null, phone: body.phone || null,
    pinHash: hash, pinSalt: salt,
  });
  await db.insert(schema.memberships).values({ id: newId(), userId, businessId: biz, roleId: body.roleId });
  await audit({
    actor: actor(c), action: "user.create", entity: "user", entityId: userId, entityLabel: body.name,
    after: { name: body.name, phone: body.phone, role: role.key },
  });
  return c.json({ id: userId });
});

userRoutes.put("/:membershipId", can("users.manage"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const mid = param(c, "membershipId");
  const body = z.object({
    name: z.string().trim().min(2).optional(),
    nameHi: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    roleId: z.string().optional(),
    active: z.boolean().optional(),
    resetPin: z.string().optional(),
    unlock: z.boolean().optional(),
  }).parse(await c.req.json());

  const [m] = await db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, mid), eq(schema.memberships.businessId, biz))).limit(1);
  if (!m) throw notFound("Member not found");
  const [before] = await db.select().from(schema.users).where(eq(schema.users.id, m.userId)).limit(1);
  if (!before) throw notFound("User not found");

  // never let the last owner lock themselves out
  if (body.active === false || body.roleId) {
    const [ownerRole] = await db.select().from(schema.roles)
      .where(and(eq(schema.roles.businessId, biz), eq(schema.roles.key, "owner"))).limit(1);
    if (ownerRole && m.roleId === ownerRole.id) {
      const owners = await db.select({ id: schema.memberships.id }).from(schema.memberships)
        .where(and(eq(schema.memberships.businessId, biz), eq(schema.memberships.roleId, ownerRole.id), eq(schema.memberships.active, true)));
      const stillOwner = body.roleId ? body.roleId === ownerRole.id : true;
      const stillActive = body.active !== false;
      if (owners.length <= 1 && (!stillOwner || !stillActive)) {
        throw new HttpError(409, "This is the only Owner. Make someone else an Owner first.", "last_owner");
      }
    }
  }

  const userPatch: Record<string, unknown> = { updatedAt: nowSec() };
  if (body.name !== undefined) userPatch.name = body.name;
  if (body.nameHi !== undefined) userPatch.nameHi = body.nameHi || null;
  if (body.phone !== undefined) userPatch.phone = body.phone || null;
  if (body.unlock) { userPatch.failedAttempts = 0; userPatch.lockedUntil = null; }
  if (body.resetPin) {
    const weak = weakPin(body.resetPin);
    if (weak) throw bad(weak, "weak_pin");
    const { hash, salt } = hashPin(body.resetPin);
    userPatch.pinHash = hash;
    userPatch.pinSalt = salt;
    userPatch.failedAttempts = 0;
    userPatch.lockedUntil = null;
  }
  if (Object.keys(userPatch).length > 1) {
    await db.update(schema.users).set(userPatch).where(eq(schema.users.id, m.userId));
  }
  if (body.roleId || body.active !== undefined) {
    await db.update(schema.memberships).set({
      ...(body.roleId ? { roleId: body.roleId } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    }).where(eq(schema.memberships.id, mid));
  }

  const [after] = await db.select().from(schema.users).where(eq(schema.users.id, m.userId)).limit(1);
  await audit({ actor: actor(c), action: "user.update", entity: "user", entityId: m.userId, entityLabel: after!.name, before, after });
  if (body.resetPin) {
    await audit({ actor: actor(c), action: "user.pin.reset", entity: "user", entityId: m.userId, entityLabel: after!.name });
  }
  return c.json({ ok: true });
});

/** Per-user grant/revoke on top of the role. */
userRoutes.put("/:membershipId/overrides", can("roles.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const mid = param(c, "membershipId");
  const { overrides } = z.object({
    overrides: z.array(z.object({
      permission: z.enum(ALL_PERMISSIONS as [string, ...string[]]),
      effect: z.enum(["allow", "deny"]),
    })),
  }).parse(await c.req.json());

  const [m] = await db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, mid), eq(schema.memberships.businessId, biz))).limit(1);
  if (!m) throw notFound("Member not found");

  const before = await db.select().from(schema.userPermissionOverrides)
    .where(eq(schema.userPermissionOverrides.membershipId, mid));
  await db.delete(schema.userPermissionOverrides).where(eq(schema.userPermissionOverrides.membershipId, mid));
  for (const o of overrides) {
    await db.insert(schema.userPermissionOverrides).values({
      id: newId(), membershipId: mid, permission: o.permission, effect: o.effect,
    });
  }
  await audit({
    actor: actor(c), action: "user.overrides.update", entity: "membership", entityId: mid,
    before: before.map((b) => ({ permission: b.permission, effect: b.effect })), after: overrides,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------- roles */

export const roleRoutes = new Hono<Env>();

roleRoutes.get("/", can("users.read", "roles.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const roles = await db.select().from(schema.roles)
    .where(eq(schema.roles.businessId, biz)).orderBy(asc(schema.roles.rank));
  const ids = roles.map((r) => r.id);
  const perms = ids.length
    ? await db.select().from(schema.rolePermissions).where(inArray(schema.rolePermissions.roleId, ids))
    : [];
  const counts = await db.select({ roleId: schema.memberships.roleId, userId: schema.memberships.userId })
    .from(schema.memberships).where(eq(schema.memberships.businessId, biz));
  return c.json(roles.map((r) => ({
    ...r,
    permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
    userCount: counts.filter((m) => m.roleId === r.id).length,
  })));
});

roleRoutes.post("/", can("roles.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscore"),
    label: z.string().trim().min(2),
    labelHi: z.string().trim().optional(),
    permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).default([]),
  }).parse(await c.req.json());

  const [dupe] = await db.select({ id: schema.roles.id }).from(schema.roles)
    .where(and(eq(schema.roles.businessId, biz), eq(schema.roles.key, body.key))).limit(1);
  if (dupe) throw bad(`Role "${body.key}" already exists`, "duplicate");

  const id = newId();
  await db.insert(schema.roles).values({
    id, businessId: biz, key: body.key, label: body.label,
    labelHi: body.labelHi || toHinglish(body.labelHi ?? "") || null,
    isSystem: false, rank: 60,
  });
  for (const p of body.permissions) {
    await db.insert(schema.rolePermissions).values({ id: newId(), roleId: id, permission: p });
  }
  await audit({ actor: actor(c), action: "role.create", entity: "role", entityId: id, entityLabel: body.label, after: body });
  return c.json({ id });
});

roleRoutes.put("/:id", can("roles.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = z.object({
    label: z.string().trim().min(2).optional(),
    labelHi: z.string().trim().optional(),
    permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).optional(),
  }).parse(await c.req.json());

  const [role] = await db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, id), eq(schema.roles.businessId, biz))).limit(1);
  if (!role) throw notFound("Role not found");

  const beforePerms = (await db.select().from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, id))).map((p) => p.permission);

  // the Owner role must keep every permission, or the business becomes unadministrable
  if (role.key === "owner" && body.permissions && body.permissions.length !== ALL_PERMISSIONS.length) {
    throw new HttpError(409, "The Owner role must keep all permissions.", "owner_locked");
  }

  if (body.label || body.labelHi !== undefined) {
    await db.update(schema.roles).set({
      ...(body.label ? { label: body.label } : {}),
      ...(body.labelHi !== undefined ? { labelHi: body.labelHi || null } : {}),
    }).where(eq(schema.roles.id, id));
  }
  if (body.permissions) {
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id));
    for (const p of body.permissions) {
      await db.insert(schema.rolePermissions).values({ id: newId(), roleId: id, permission: p });
    }
  }
  await audit({
    actor: actor(c), action: "role.update", entity: "role", entityId: id, entityLabel: role.label,
    before: { label: role.label, permissions: beforePerms },
    after: { label: body.label ?? role.label, permissions: body.permissions ?? beforePerms },
  });
  return c.json({ ok: true });
});

roleRoutes.delete("/:id", can("roles.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [role] = await db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, id), eq(schema.roles.businessId, biz))).limit(1);
  if (!role) throw notFound("Role not found");
  if (role.isSystem) throw new HttpError(409, "Built-in roles cannot be deleted. Edit its permissions instead.", "system_role");
  const [used] = await db.select({ id: schema.memberships.id }).from(schema.memberships)
    .where(eq(schema.memberships.roleId, id)).limit(1);
  if (used) throw new HttpError(409, "Move the users off this role first.", "role_in_use");
  await db.delete(schema.roles).where(eq(schema.roles.id, id));
  await audit({ actor: actor(c), action: "role.delete", entity: "role", entityId: id, entityLabel: role.label, before: role });
  return c.json({ ok: true });
});
