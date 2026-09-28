const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const FEED_URL =
 "https://utility.arcgis.com/usrsvcs/servers/01c97e2928134efc93157d99f2d23047/rest/services/OpenData/Public_Safety/FeatureServer/0/query";
app.get("/api/incidents", async (req, res) => {
  try {
    const params = new URLSearchParams({
  where: "1=1",
  outFields: "ObjectID,InfoTitle,Call_Type,Address,Reported_Time",
  returnGeometry: "false",

  geometry: JSON.stringify({
    xmin: -10958012.374962993,
    ymin: 4226661.916058987,
    xmax: -10801469.341034994,
    ymax: 4383204.949986987
  }),

  geometryType: "esriGeometryEnvelope",
  inSR: "102100",
  spatialRel: "esriSpatialRelIntersects",
  
  f: "json"
});

    const url = `${FEED_URL}?${params.toString()}`;

    console.log("Requesting OKC feed:", url);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`ArcGIS HTTP error: ${response.status}`);
    }

    const data = await response.json();

    // IMPORTANT: show us an ArcGIS error instead of pretending
    // there are simply zero incidents.
    if (data.error) {
      console.error("ArcGIS error:", data.error);

      return res.status(500).json({
        success: false,
        error: data.error
      });
    }

    let incidents = (data.features || []).map(feature => ({
      ...feature.attributes
    }));

    // Sort newest calls first here instead of making ArcGIS do it.
    incidents.sort((a, b) => {
      return Number(b.Reported_Time || 0) - Number(a.Reported_Time || 0);
    });

    res.json({
      success: true,
      count: incidents.length,
      incidents
    });

  } catch (error) {
    console.error("Feed error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "OKC Breaking News Monitor V2"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OKC Breaking News Monitor running on port ${PORT}`);
});
