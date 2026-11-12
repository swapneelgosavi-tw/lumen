<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:dp="http://www.datapower.com/extensions" extension-element-prefixes="dp">
  <xsl:template match="/"><dp:set-variable name="'var://service/routing-url'" value="'https://pay-routed.example.com/charge'"/></xsl:template>
</xsl:stylesheet>
