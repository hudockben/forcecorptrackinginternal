-- ForceCorpTracking Database Schema

CREATE TABLE cost_items (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    cost_code             TEXT NOT NULL,
    sub_code              TEXT,
    quantity              REAL NOT NULL DEFAULT 0,       -- Bid Quantity
    running_quantities    REAL NOT NULL DEFAULT 0,       -- Actual quantity to date
    bid_item_cost         REAL NOT NULL DEFAULT 0,       -- Cost per unit at bid
    running_item_cost     REAL NOT NULL DEFAULT 0,       -- Actual cost per unit (running)
    past_avg              REAL,                          -- From Company Level Reporting
    status                TEXT NOT NULL DEFAULT 'Active'
                          CHECK(status IN ('Active','Complete','On Hold','At Risk')),
    cumulative_labor_hours REAL NOT NULL DEFAULT 0,
    days_worked           INTEGER NOT NULL DEFAULT 0,
    num_laborers          INTEGER NOT NULL DEFAULT 0,
    equip_total_cost      REAL NOT NULL DEFAULT 0,       -- Used to calc equipment_cost_per_hour
    equipment_hours       REAL NOT NULL DEFAULT 0,       -- Used to calc equipment_cost_per_hour and mu_per_equip_hour
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Calculated / derived columns (for reference — compute these in application logic or views):
--
--  percent_completed       = (running_quantities / quantity) * 100
--  bid_cost_total          = quantity * bid_item_cost
--  running_total_cost      = running_quantities * running_item_cost
--  total_cost_pct          = (running_total_cost / bid_cost_total) * 100
--  projected_cost          = running_total_cost + ((quantity - running_quantities) * running_item_cost)
--  mu_per_laborer_hour     = running_total_cost / cumulative_labor_hours
--  equipment_cost_per_hour = equip_total_cost / equipment_hours
--  mu_per_equip_hour       = quantity / equipment_hours

CREATE VIEW cost_items_calculated AS
SELECT
    id,
    cost_code,
    sub_code,
    quantity,
    running_quantities,
    CASE WHEN quantity != 0
         THEN ROUND((running_quantities / quantity) * 100, 2)
         ELSE 0 END                                                     AS percent_completed,
    bid_item_cost,
    running_item_cost,
    past_avg,
    ROUND(quantity * bid_item_cost, 2)                                  AS bid_cost_total,
    ROUND(running_quantities * running_item_cost, 2)                    AS running_total_cost,
    CASE WHEN (quantity * bid_item_cost) != 0
         THEN ROUND(((running_quantities * running_item_cost) / (quantity * bid_item_cost)) * 100, 2)
         ELSE 0 END                                                     AS total_cost_pct,
    status,
    ROUND(
        (running_quantities * running_item_cost)
        + ((quantity - running_quantities) * running_item_cost)
    , 2)                                                                AS projected_cost,
    cumulative_labor_hours,
    days_worked,
    num_laborers,
    CASE WHEN cumulative_labor_hours != 0
         THEN ROUND((running_quantities * running_item_cost) / cumulative_labor_hours, 4)
         ELSE 0 END                                                     AS mu_per_laborer_hour,
    equip_total_cost,
    equipment_hours,
    CASE WHEN equipment_hours != 0
         THEN ROUND(equip_total_cost / equipment_hours, 4)
         ELSE 0 END                                                     AS equipment_cost_per_hour,
    CASE WHEN equipment_hours != 0
         THEN ROUND(quantity / equipment_hours, 4)
         ELSE 0 END                                                     AS mu_per_equip_hour,
    created_at,
    updated_at
FROM cost_items;

-- Trigger to auto-update updated_at on row change
CREATE TRIGGER cost_items_updated
AFTER UPDATE ON cost_items
BEGIN
    UPDATE cost_items SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ─────────────────────────────────────────────────
-- DAILY TRACKING
-- ─────────────────────────────────────────────────

CREATE TABLE daily_tracking (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    date              DATE    NOT NULL,
    field_type        VARCHAR(255),
    employee          VARCHAR(255),
    cost_code         VARCHAR(255),
    sub_code          VARCHAR(255),
    job_class         VARCHAR(255),
    rate              REAL    NOT NULL DEFAULT 0,
    labor_hours       REAL    NOT NULL DEFAULT 0,
    -- labor_cost = rate * labor_hours  (computed)
    equipment         VARCHAR(255),
    equip_unit_cost   REAL    NOT NULL DEFAULT 0,
    equip_hours       REAL    NOT NULL DEFAULT 0,
    -- equip_total_cost = equip_unit_cost * equip_hours  (computed)
    material          TEXT,
    supplier          VARCHAR(255),
    po_num            VARCHAR(50),
    units_purchased   REAL    NOT NULL DEFAULT 0,
    unit_cost         REAL    NOT NULL DEFAULT 0,
    material_cost     REAL    NOT NULL DEFAULT 0,
    -- total_cost = labor_cost + equip_total_cost + material_cost  (computed)
    quantity          REAL    NOT NULL DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIEW daily_tracking_calculated AS
SELECT
    id,
    date,
    field_type,
    employee,
    cost_code,
    sub_code,
    job_class,
    rate,
    labor_hours,
    ROUND(rate * labor_hours, 2)                                           AS labor_cost,
    equipment,
    equip_unit_cost,
    equip_hours,
    ROUND(equip_unit_cost * equip_hours, 2)                               AS equip_total_cost,
    material,
    supplier,
    po_num,
    units_purchased,
    unit_cost,
    material_cost,
    ROUND((rate * labor_hours) + (equip_unit_cost * equip_hours) + material_cost, 2) AS total_cost,
    quantity,
    created_at,
    updated_at
FROM daily_tracking;

CREATE TRIGGER daily_tracking_updated
AFTER UPDATE ON daily_tracking
BEGIN
    UPDATE daily_tracking SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ─────────────────────────────────────────────────
-- DROPDOWN LISTS  (managed per-project)
-- ─────────────────────────────────────────────────

CREATE TABLE dropdown_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_name  VARCHAR(50) NOT NULL,   -- e.g. 'field_types', 'employees', 'job_classes', 'suppliers'
    value      VARCHAR(255) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(list_name, value)
);

-- Equipment has an additional unit_cost column
CREATE TABLE equipment_list (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       VARCHAR(255) NOT NULL UNIQUE,
    unit_cost  REAL NOT NULL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
);
