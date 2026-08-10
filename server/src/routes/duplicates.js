import { Router } from "express";
import { parsePositiveInt } from "../validation.js";
import { getDuplicateCases, resolveDuplicateCase } from "../services/duplicate-service.js";

export const duplicates = Router();
duplicates.get("/", (req, res, next) => { try { res.json({ duplicates: getDuplicateCases(req.user.id, String(req.query.status || "pending")) }); } catch (error) { next(error); } });
duplicates.post("/:id/resolve", async (req, res, next) => {
  const duplicateId = parsePositiveInt(req.params.id);
  if (!duplicateId) return res.status(400).json({ error: "Invalid duplicate ID." });
  try { res.json({ duplicate: await resolveDuplicateCase(req.user.id, duplicateId, req.body?.action) }); } catch (error) { next(error); }
});
