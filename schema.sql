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
--  total_cost_bid          = quantity * bid_item_cost
--  running_total_cost      = running_quantities * running_item_cost
--  total_cost_pct          = (running_total_cost / total_cost_bid) * 100
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
    ROUND(quantity * bid_item_cost, 2)                                  AS total_cost_bid,
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
